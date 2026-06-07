import { and, desc, eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { projects, type ProjectRow } from '@main/db/schema';
import type { LocalProject, SshProject } from '@shared/projects';

/** Maps a project row to its shared DTO, discriminating on the workspace provider. */
function toProject(row: ProjectRow): LocalProject | SshProject {
  const base = {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    path: row.path,
    baseRef: row.baseRef ?? 'main',
    repositoryWorkspaceId: row.repositoryWorkspaceId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  return row.workspaceProvider === 'local'
    ? { type: 'local', ...base }
    : { type: 'ssh', ...base, connectionId: row.sshConnectionId! };
}

export async function getProjects(): Promise<(LocalProject | SshProject)[]> {
  const rows = await db.select().from(projects).orderBy(desc(projects.updatedAt));
  return rows.map(toProject);
}

/** Lists the projects belonging to a single organization, newest first. */
export async function listProjectsForOrganization(
  organizationId: string
): Promise<(LocalProject | SshProject)[]> {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.organizationId, organizationId))
    .orderBy(desc(projects.updatedAt));
  return rows.map(toProject);
}

export async function getProjectById(
  projectId: string
): Promise<LocalProject | SshProject | undefined> {
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  return row ? toProject(row) : undefined;
}

export async function getLocalProjectByPath(path: string): Promise<LocalProject | undefined> {
  const [row] = await db.select().from(projects).where(eq(projects.path, path)).limit(1);
  if (!row || row.workspaceProvider !== 'local') return undefined;
  return toProject(row) as LocalProject;
}

export async function getSshProjectByPath(
  path: string,
  connectionId: string
): Promise<SshProject | undefined> {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.path, path), eq(projects.sshConnectionId, connectionId)))
    .limit(1);
  if (!row) return undefined;
  return toProject(row) as SshProject;
}
