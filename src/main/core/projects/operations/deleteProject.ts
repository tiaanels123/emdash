import { eq } from 'drizzle-orm';
import { projectEvents } from '@main/core/projects/project-events';
import { projectManager } from '@main/core/projects/project-manager';
import { prSyncEngine } from '@main/core/pull-requests/pr-sync-engine';
import { getTasks } from '@main/core/tasks/operations/getTasks';
import { taskSessionManager } from '@main/core/tasks/task-session-manager';
import { viewStateService } from '@main/core/view-state/view-state-service';
import { db } from '@main/db/client';
import { projects, taskProjects } from '@main/db/schema';
import { telemetryService } from '@main/lib/telemetry';

export async function deleteProject(id: string): Promise<void> {
  const provider = projectManager.getProject(id);
  if (provider) {
    const projectTasks = await getTasks(id);
    await Promise.allSettled([
      ...projectTasks.map((t) => taskSessionManager.teardownTask(t.id)),
      ...projectTasks.map((t) => viewStateService.del(`task:${t.id}`)),
    ]);
    await projectManager.closeProject(id);
  }

  await prSyncEngine.deleteProjectData(id);
  // Detach this project from every task attachment (FKs are unenforced at
  // runtime) — multi-repo tasks that attached it as a secondary repo keep
  // working against their remaining repos.
  await db.delete(taskProjects).where(eq(taskProjects.projectId, id));
  await db.delete(projects).where(eq(projects.id, id));
  void viewStateService.del(`project:${id}`);
  projectEvents._emit('project:deleted', id);
  telemetryService.capture('project_deleted', { project_id: id });
}
