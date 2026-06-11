import crypto from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { mapConversationRowToConversation } from '@main/core/conversations/utils';
import { projectManager } from '@main/core/projects/project-manager';
import { db, type DrizzleTx } from '@main/db/client';
import { conversations, projects, taskProjects, tasks, workspaces } from '@main/db/schema';
import type { ConversationRow, TaskProjectInsert, TaskRow } from '@main/db/schema';
import { events } from '@main/lib/events';
import type { ConversationConfig } from '@shared/core/conversations/conversation-config';
import { conversationCreatedChannel } from '@shared/core/conversations/conversationEvents';
import type { Conversation } from '@shared/core/conversations/conversations';
import type {
  CreateTaskError,
  CreateTaskParams,
  CreateTaskSuccess,
  TaskLifecycleStatus,
} from '@shared/core/tasks/tasks';
import type { WorkspaceConfig } from '@shared/core/workspaces/workspace-config';
import { err, ok, type Result } from '@shared/lib/result';
import { mapTaskRowToTask } from '../utils/utils';

type ConvInsert = typeof conversations.$inferInsert;
type WorkspaceInsert = typeof workspaces.$inferInsert;

type ProjectInfo = {
  id: string;
  organizationId: string;
  workspaceProvider: string;
  sshConnectionId: string | null;
};

export interface PreparedCreateTask {
  params: CreateTaskParams;
  initialStatus: TaskLifecycleStatus;
  organizationId: string;
  /** Primary workspace id (mirrored onto the task row). */
  workspaceId: string;
  /** New workspace rows to insert (primary and/or additional repos). */
  newWorkspaces: WorkspaceInsert[];
  /** One attachment row per repo, primary first (sortOrder 0). */
  attachments: TaskProjectInsert[];
  convInsert: ConvInsert | undefined;
}

/**
 * Resolves the workspace id for one repo's workspace config, queuing a new
 * workspace row when the target is not an existing repository instance.
 */
function resolveWorkspaceForRepo(
  workspaceConfig: WorkspaceConfig,
  project: ProjectInfo,
  newWorkspaces: WorkspaceInsert[]
): string {
  const wsTarget = workspaceConfig.workspace;
  if (wsTarget.kind === 'repository-instance') {
    return wsTarget.workspaceId;
  }

  const workspaceId = crypto.randomUUID();
  if (wsTarget.kind === 'byoi') {
    newWorkspaces.push({
      id: workspaceId,
      kind: 'byoi',
      location: 'remote',
      type: 'byoi',
      config: workspaceConfig,
    });
    return workspaceId;
  }

  // 'new-worktree' — derive location from the owning project.
  const isRemote = project.workspaceProvider === 'ssh';
  newWorkspaces.push({
    id: workspaceId,
    kind: 'worktree',
    location: isRemote ? 'remote' : 'local',
    sshConnectionId: isRemote ? project.sshConnectionId : null,
    type: isRemote ? 'project-ssh' : 'local',
    config: workspaceConfig,
  });
  return workspaceId;
}

/**
 * Performs all async preparation for creating a task (project validation, workspace
 * resolution). Returns a `PreparedCreateTask` that can be committed synchronously
 * inside a Drizzle transaction via `commitCreateTask`.
 */
export async function prepareCreateTask(
  params: CreateTaskParams
): Promise<Result<PreparedCreateTask, CreateTaskError>> {
  if (!projectManager.getProject(params.projectId)) {
    return err({ type: 'project-not-found' });
  }

  // Drop duplicate / primary-repeating entries before validation.
  const additionalRepos = (params.additionalRepos ?? []).filter(
    (repo, index, list) =>
      repo.projectId !== params.projectId &&
      list.findIndex((r) => r.projectId === repo.projectId) === index
  );

  const projectIds = [params.projectId, ...additionalRepos.map((r) => r.projectId)];
  const projectRows = await db
    .select({
      id: projects.id,
      organizationId: projects.organizationId,
      workspaceProvider: projects.workspaceProvider,
      sshConnectionId: projects.sshConnectionId,
    })
    .from(projects)
    .where(inArray(projects.id, projectIds));
  const projectById = new Map(projectRows.map((p) => [p.id, p]));

  const primaryProject = projectById.get(params.projectId);
  if (!primaryProject) return err({ type: 'project-not-found' });

  if (additionalRepos.length > 0) {
    for (const repo of additionalRepos) {
      const project = projectById.get(repo.projectId);
      if (!project || !projectManager.getProject(repo.projectId)) {
        return err({ type: 'project-not-found' });
      }
      if (project.organizationId !== primaryProject.organizationId) {
        return err({ type: 'cross-org-repos' });
      }
      // v1: multi-repo agent sessions run locally (--add-dir on one machine);
      // SSH/BYOI attachments would need per-repo transports.
      if (project.workspaceProvider !== 'local' || repo.workspaceConfig.workspace.kind === 'byoi') {
        return err({ type: 'multi-repo-requires-local' });
      }
    }
    if (
      primaryProject.workspaceProvider !== 'local' ||
      params.workspaceConfig.workspace.kind === 'byoi'
    ) {
      return err({ type: 'multi-repo-requires-local' });
    }
  }

  const initialStatus: TaskLifecycleStatus = params.taskConfig.initialStatus ?? 'in_progress';

  const newWorkspaces: WorkspaceInsert[] = [];
  const workspaceId = resolveWorkspaceForRepo(params.workspaceConfig, primaryProject, newWorkspaces);

  const attachments: TaskProjectInsert[] = [
    { taskId: params.id, projectId: params.projectId, workspaceId, sortOrder: 0 },
  ];
  additionalRepos.forEach((repo, index) => {
    const project = projectById.get(repo.projectId)!;
    const repoWorkspaceId = resolveWorkspaceForRepo(repo.workspaceConfig, project, newWorkspaces);
    attachments.push({
      taskId: params.id,
      projectId: repo.projectId,
      workspaceId: repoWorkspaceId,
      sortOrder: index + 1,
    });
  });

  let convInsert: ConvInsert | undefined;
  if (params.taskConfig.initialConversation) {
    const ic = params.taskConfig.initialConversation;
    const configObj: ConversationConfig = {};
    if (ic.autoApprove !== undefined) configObj.autoApprove = ic.autoApprove;
    if (ic.effort?.trim()) configObj.effort = ic.effort.trim();
    if (ic.initialPrompt?.trim()) configObj.initialPrompt = ic.initialPrompt.trim();
    const config = Object.keys(configObj).length > 0 ? configObj : undefined;
    convInsert = {
      id: ic.id,
      projectId: params.projectId,
      taskId: params.id,
      title: ic.title ?? '',
      provider: ic.provider,
      config,
      isInitialConversation: true,
      lastInteractedAt: new Date().toISOString(),
    };
  }

  return ok({
    params,
    initialStatus,
    organizationId: primaryProject.organizationId,
    workspaceId,
    newWorkspaces,
    attachments,
    convInsert,
  });
}

/**
 * Synchronously runs the task/workspace/conversation inserts within the provided
 * transaction. Must be called with a `PreparedCreateTask` from `prepareCreateTask`.
 * Returns the raw DB rows; call `finalizeCreateTask` after the transaction commits
 * to build the result and emit side-effect events.
 */
export function commitCreateTask(
  prepared: PreparedCreateTask,
  tx: DrizzleTx
): { taskRow: TaskRow; convRow: ConversationRow | undefined } {
  const { params, initialStatus, organizationId, workspaceId, newWorkspaces, attachments, convInsert } =
    prepared;

  const [taskRow] = tx
    .insert(tasks)
    .values({
      id: params.id,
      organizationId,
      projectId: params.projectId,
      name: params.taskConfig.name,
      status: initialStatus,
      workspaceId,
      linkedIssue: params.taskConfig.linkedIssue ?? null,
      type: params.automationRunId ? 'automation-run' : 'task',
      automationRunId: params.automationRunId ?? null,
      updatedAt: sql`CURRENT_TIMESTAMP`,
      statusChangedAt: sql`CURRENT_TIMESTAMP`,
      lastInteractedAt: sql`CURRENT_TIMESTAMP`,
    })
    .returning()
    .all();

  for (const newWorkspace of newWorkspaces) {
    tx.insert(workspaces).values(newWorkspace).run();
  }
  for (const attachment of attachments) {
    tx.insert(taskProjects).values(attachment).run();
  }

  let convRow: ConversationRow | undefined;
  if (convInsert) {
    [convRow] = tx.insert(conversations).values(convInsert).returning().all();
  }

  return { taskRow, convRow };
}

/**
 * Builds the `CreateTaskSuccess` result and emits post-commit side-effect events.
 * Call this after the transaction that ran `commitCreateTask` has committed.
 */
export function finalizeCreateTask(
  prepared: PreparedCreateTask,
  taskRow: TaskRow,
  convRow: ConversationRow | undefined
): CreateTaskSuccess {
  const repos = prepared.attachments.map((a) => ({
    projectId: a.projectId,
    workspaceId: a.workspaceId ?? undefined,
    sortOrder: a.sortOrder ?? 0,
  }));
  const task = mapTaskRowToTask(taskRow, [], {}, repos);

  let initialConversation: Conversation | undefined;
  if (convRow) {
    initialConversation = mapConversationRowToConversation(convRow);
    events.emit(conversationCreatedChannel, { conversation: initialConversation });
  }

  return { task: { ...task, workspaceId: prepared.workspaceId }, initialConversation };
}

export async function createTask(
  params: CreateTaskParams
): Promise<Result<CreateTaskSuccess, CreateTaskError>> {
  const prepared = await prepareCreateTask(params);
  if (!prepared.success) return prepared;

  let taskRow!: TaskRow;
  let convRow: ConversationRow | undefined;
  db.transaction((tx) => {
    ({ taskRow, convRow } = commitCreateTask(prepared.data, tx));
  });

  return ok(finalizeCreateTask(prepared.data, taskRow, convRow));
}
