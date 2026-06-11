import { count, eq } from 'drizzle-orm';
import { deleteProject } from '@main/core/projects/operations/deleteProject';
import { db } from '@main/db/client';
import { mcpServers, organizations, organizationSettings, projects } from '@main/db/schema';
import { err, ok, type Result } from '@shared/lib/result';
import {
  type DeleteOrganizationOptions,
  isPersonalOrganization,
  type OrganizationError,
} from '@shared/organizations';

/**
 * Deletes an organization.
 *
 * - The default Personal organization can never be deleted.
 * - A non-empty organization is refused unless `cascade` is set, in which case
 *   all of its projects are torn down first (via the normal project-deletion
 *   path, so worktrees/PR data/view state are cleaned up properly).
 * - Org-scoped settings are removed explicitly because foreign keys are not
 *   enforced at runtime.
 */
export async function deleteOrganization(
  id: string,
  options?: DeleteOrganizationOptions
): Promise<Result<void, OrganizationError>> {
  if (isPersonalOrganization(id)) {
    return err({ type: 'is_personal', message: 'The Personal organization cannot be deleted' });
  }

  const [existing] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, id))
    .limit(1);
  if (!existing) {
    return err({ type: 'not_found', message: `Organization ${id} not found` });
  }

  const [{ projectCount }] = await db
    .select({ projectCount: count() })
    .from(projects)
    .where(eq(projects.organizationId, id));

  if (projectCount > 0) {
    if (!options?.cascade) {
      return err({ type: 'not_empty', projectCount });
    }
    const rows = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.organizationId, id));
    for (const row of rows) {
      await deleteProject(row.id);
    }
  }

  await db.delete(organizationSettings).where(eq(organizationSettings.organizationId, id));
  await db.delete(mcpServers).where(eq(mcpServers.organizationId, id));
  await db.delete(organizations).where(eq(organizations.id, id));
  return ok();
}
