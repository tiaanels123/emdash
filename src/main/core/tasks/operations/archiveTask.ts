import { eq, sql } from 'drizzle-orm';
import { projectManager } from '@main/core/projects/project-manager';
import { taskSessionManager } from '@main/core/tasks/task-session-manager';
import { db } from '@main/db/client';
import { taskProjects, tasks, workspaces } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { telemetryService } from '@main/lib/telemetry';
import { deleteIndexIfUnused, removeWorktreeIfUnused } from './task-lifecycle-utils';

export async function archiveTask(projectId: string, taskId: string): Promise<void> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task) return;

  const project = projectManager.getProject(projectId);

  await db
    .update(tasks)
    .set({
      status: 'archived',
      archivedAt: sql`CURRENT_TIMESTAMP`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
      statusChangedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(tasks.id, taskId));
  telemetryService.capture('task_archived', { project_id: projectId, task_id: taskId });

  if (!project) return;

  void taskSessionManager
    .teardownTask(taskId, 'terminate')
    .then((teardownResult) => {
      if (!teardownResult.success) {
        log.warn('archiveTask: teardown failed', { taskId, error: teardownResult.error.message });
      }
    })
    .catch((e: unknown) => {
      log.warn('archiveTask: teardown failed', { taskId, error: String(e) });
    });

  // Clean up worktrees/indexes for every attached repo (primary + additional).
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

  for (const [repoProjectId, workspaceId] of repoWorkspaces) {
    if (!workspaceId) continue;

    const repoProject =
      repoProjectId === projectId ? project : projectManager.getProject(repoProjectId);
    if (repoProject) {
      const [ws] = await db
        .select({ id: workspaces.id, branchName: workspaces.branchName })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      if (ws) {
        await removeWorktreeIfUnused(ws, repoProject, true);
      }
    }

    await deleteIndexIfUnused(workspaceId);
  }
}
