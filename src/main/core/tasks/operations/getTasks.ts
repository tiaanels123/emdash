import { and, asc, count, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@main/db/client';
import { conversations, taskProjects, tasks, workspaces } from '@main/db/schema';
import { type Task, type TaskRepo } from '@shared/core/tasks/tasks';
import { mapTaskRowToTask } from '../utils/utils';

export async function getTasks(projectId?: string): Promise<Task[]> {
  const rows = projectId
    ? await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.projectId, projectId)))
        .orderBy(desc(tasks.updatedAt))
    : await db.select().from(tasks).orderBy(desc(tasks.updatedAt));

  if (rows.length === 0) return [];

  const taskIds = rows.map((r) => r.id);

  const convRows = await db
    .select({
      taskId: conversations.taskId,
      provider: conversations.provider,
      count: count(),
    })
    .from(conversations)
    .where(inArray(conversations.taskId, taskIds))
    .groupBy(conversations.taskId, conversations.provider);

  const convByTask = new Map<string, Record<string, number>>();
  for (const { taskId, provider, count: c } of convRows) {
    const rec = convByTask.get(taskId) ?? {};
    rec[provider ?? 'unknown'] = c;
    convByTask.set(taskId, rec);
  }

  const repoRows = await db
    .select({
      taskId: taskProjects.taskId,
      projectId: taskProjects.projectId,
      workspaceId: taskProjects.workspaceId,
      sortOrder: taskProjects.sortOrder,
    })
    .from(taskProjects)
    .where(inArray(taskProjects.taskId, taskIds))
    .orderBy(asc(taskProjects.sortOrder));

  const reposByTask = new Map<string, TaskRepo[]>();
  for (const { taskId, projectId, workspaceId, sortOrder } of repoRows) {
    const list = reposByTask.get(taskId) ?? [];
    list.push({ projectId, workspaceId: workspaceId ?? undefined, sortOrder });
    reposByTask.set(taskId, list);
  }

  const wsIds = rows.map((r) => r.workspaceId).filter((id): id is string => id != null);
  const wsRows = wsIds.length
    ? await db
        .select({
          id: workspaces.id,
          linesAdded: workspaces.linesAdded,
          linesDeleted: workspaces.linesDeleted,
        })
        .from(workspaces)
        .where(inArray(workspaces.id, wsIds))
    : [];
  const wsByWsId = new Map(wsRows.map((r) => [r.id, r]));

  return rows.map((row) => {
    const ws = row.workspaceId ? wsByWsId.get(row.workspaceId) : undefined;
    return {
      ...mapTaskRowToTask(row, [], {}, reposByTask.get(row.id)),
      prs: [],
      conversations: convByTask.get(row.id) ?? {},
      workspaceGit:
        ws?.linesAdded != null
          ? { linesAdded: ws.linesAdded, linesDeleted: ws.linesDeleted ?? 0 }
          : undefined,
    };
  });
}
