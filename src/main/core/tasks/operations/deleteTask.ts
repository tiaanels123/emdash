import { eq } from 'drizzle-orm';
import { projectManager } from '@main/core/projects/project-manager';
import { taskSessionManager } from '@main/core/tasks/task-session-manager';
import { viewStateService } from '@main/core/view-state/view-state-service';
import { db } from '@main/db/client';
import { taskProjects, tasks, workspaces } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { telemetryService } from '@main/lib/telemetry';
import type { DeleteTaskOptions } from '@shared/core/tasks/tasks';
import type { WorkspaceConfig } from '@shared/core/workspaces/workspace-config';
import { deleteWorkspaceIfUnused, removeWorktreeIfUnused } from './task-lifecycle-utils';

type WorkspaceRowInfo = { id: string; branchName: string | null; config: WorkspaceConfig | null };

export async function deleteTask(
  projectId: string,
  taskId: string,
  options: DeleteTaskOptions = {}
): Promise<void> {
  const { deleteWorktree = true, deleteBranch = false } = options;

  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task) return;

  const project = projectManager.getProject(projectId);

  if (project) {
    const teardownResult = await taskSessionManager.teardownTask(taskId, 'terminate').catch((e) => {
      log.warn('deleteTask: teardown failed', { taskId, error: String(e) });
      return null;
    });

    if (teardownResult && !teardownResult.success) {
      log.warn('deleteTask: teardown failed', { taskId, error: teardownResult.error.message });
    }
  }

  // One (projectId, workspaceId) pair per attached repo. The primary attachment
  // mirrors tasks.workspaceId; legacy tasks without attachment rows fall back to
  // the task columns.
  const attachments = await db
    .select({ projectId: taskProjects.projectId, workspaceId: taskProjects.workspaceId })
    .from(taskProjects)
    .where(eq(taskProjects.taskId, taskId));
  const repoWorkspaces = new Map<string, string | null>();
  for (const attachment of attachments) {
    repoWorkspaces.set(attachment.projectId, attachment.workspaceId);
  }
  if (!repoWorkspaces.has(task.projectId)) {
    repoWorkspaces.set(task.projectId, task.workspaceId);
  }

  // Load workspace rows before deleting them (we may need branchName for worktree removal).
  const wsRowByProject = new Map<string, WorkspaceRowInfo>();
  for (const [repoProjectId, workspaceId] of repoWorkspaces) {
    if (!workspaceId) continue;
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (ws) wsRowByProject.set(repoProjectId, ws);
    await deleteWorkspaceIfUnused(workspaceId, taskId);
  }

  await db.delete(taskProjects).where(eq(taskProjects.taskId, taskId));
  await db.delete(tasks).where(eq(tasks.id, taskId));
  void viewStateService.del(`task:${taskId}`);
  telemetryService.capture('task_deleted', { project_id: projectId, task_id: taskId });

  if (!deleteWorktree) return;

  for (const [repoProjectId, wsRow] of wsRowByProject) {
    const repoProject =
      repoProjectId === projectId ? project : projectManager.getProject(repoProjectId);
    if (!repoProject) continue;

    const worktreeRemoved = await removeWorktreeIfUnused(wsRow, repoProject, false);
    if (worktreeRemoved && deleteBranch && wsRow.branchName) {
      const fromBranch =
        wsRow.config?.git.kind === 'create-branch' ? wsRow.config.git.fromBranch : undefined;
      if (fromBranch && wsRow.branchName !== fromBranch.branch) {
        const branchDelete = await repoProject.repository
          .deleteBranch(wsRow.branchName)
          .catch((e) => {
            log.warn('deleteTask: branch deletion failed', { taskId, error: String(e) });
            return null;
          });
        if (branchDelete && !branchDelete.success) {
          log.warn('deleteTask: branch deletion failed', { taskId, error: branchDelete.error });
        }
      }
    }
  }
}
