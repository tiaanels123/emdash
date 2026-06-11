import { and, eq, isNull, ne } from 'drizzle-orm';
import { workspaceFileIndexService } from '@main/core/search/workspace-file-index-service';
import { db } from '@main/db/client';
import { taskProjects, tasks, workspaces } from '@main/db/schema';
import { log } from '@main/lib/logger';
import type { ProjectProvider } from '../../projects/project-provider';

/**
 * True when any task still references the workspace — via the legacy
 * `tasks.workspaceId` column or a `task_projects` attachment row.
 *
 * `excludeArchived` ignores archived tasks; `excludeTaskId` ignores the task
 * being deleted (whose rows may still exist at call time).
 */
async function workspaceHasSiblings(
  workspaceId: string,
  opts: { excludeArchived?: boolean; excludeTaskId?: string } = {}
): Promise<boolean> {
  const directConditions = [eq(tasks.workspaceId, workspaceId)];
  if (opts.excludeArchived) directConditions.push(isNull(tasks.archivedAt));
  if (opts.excludeTaskId) directConditions.push(ne(tasks.id, opts.excludeTaskId));

  const [direct] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(...directConditions))
    .limit(1);
  if (direct) return true;

  const joinConditions = [eq(taskProjects.workspaceId, workspaceId)];
  if (opts.excludeArchived) joinConditions.push(isNull(tasks.archivedAt));
  if (opts.excludeTaskId) joinConditions.push(ne(taskProjects.taskId, opts.excludeTaskId));

  const [attached] = await db
    .select({ id: taskProjects.taskId })
    .from(taskProjects)
    .innerJoin(tasks, eq(taskProjects.taskId, tasks.id))
    .where(and(...joinConditions))
    .limit(1);
  return attached !== undefined;
}

/**
 * Removes the worktree when no remaining sibling tasks share the same workspace.
 *
 * `excludeArchived = true`  — only non-archived siblings block removal (use for archiveTask).
 * `excludeArchived = false` — any remaining sibling blocks removal (use for deleteTask).
 *
 * Returns `true` if the worktree was removed (no siblings found), `false` otherwise.
 */
export async function removeWorktreeIfUnused(
  workspace: { id: string; branchName: string | null },
  project: ProjectProvider,
  excludeArchived: boolean
): Promise<boolean> {
  if (!workspace.branchName) return false;

  if (await workspaceHasSiblings(workspace.id, { excludeArchived })) return false;

  try {
    await project.removeTaskWorktree(workspace.branchName);
  } catch (e) {
    log.warn('removeWorktreeIfUnused: worktree removal failed', {
      branchName: workspace.branchName,
      error: String(e),
    });
    return false;
  }
  return true;
}

/**
 * Deletes the workspace row only when no other task still references it.
 *
 * Tasks are deduplicated onto a single workspace row per resolved path (see
 * `WorkspaceBootstrapService.persistPath`), so for `no-worktree` tasks every task in a
 * project shares the project-root workspace. Deleting it unconditionally orphaned the
 * siblings, whose `workspaceId` then pointed at a missing row — surfacing later as
 * `Workspace not found` during bootstrap. `excludeTaskId` is the task being deleted; its
 * rows still exist at this point, so they must not count as references.
 */
export async function deleteWorkspaceIfUnused(
  workspaceId: string,
  excludeTaskId: string
): Promise<void> {
  const [wsRow] = await db
    .select({ id: workspaces.id, kind: workspaces.kind })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  // project-root workspaces outlive any individual task — never delete them.
  if (wsRow?.kind === 'project-root') return;

  if (await workspaceHasSiblings(workspaceId, { excludeTaskId })) return;

  await db
    .delete(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .catch((e) => {
      log.warn('deleteWorkspaceIfUnused: workspace row deletion failed', {
        workspaceId,
        error: String(e),
      });
    });
}

/**
 * Deletes the workspace file index when no non-archived sibling task shares the workspace.
 */
export async function deleteIndexIfUnused(workspaceId: string): Promise<void> {
  if (!(await workspaceHasSiblings(workspaceId, { excludeArchived: true }))) {
    workspaceFileIndexService.deleteIndex(workspaceId);
  }
}
