import { eq, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { organizations } from '@main/db/schema';
import { err, ok, type Result } from '@shared/lib/result';
import {
  type Organization,
  type OrganizationError,
  type UpdateOrganizationParams,
} from '@shared/organizations';
import { toOrganization } from '../organization-row';

/**
 * Updates an organization's name, color, icon, and/or sort order. Only the
 * provided fields are changed. Renaming to an empty name is rejected.
 */
export async function updateOrganization(
  id: string,
  params: UpdateOrganizationParams
): Promise<Result<Organization, OrganizationError>> {
  let name: string | undefined;
  if (params.name !== undefined) {
    name = params.name.trim();
    if (!name) {
      return err({ type: 'invalid_name', message: 'Organization name must not be empty' });
    }
  }

  const [row] = await db
    .update(organizations)
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(params.color !== undefined ? { color: params.color } : {}),
      ...(params.icon !== undefined ? { icon: params.icon } : {}),
      ...(params.sortOrder !== undefined ? { sortOrder: params.sortOrder } : {}),
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(organizations.id, id))
    .returning();

  if (!row) {
    return err({ type: 'not_found', message: `Organization ${id} not found` });
  }
  return ok(toOrganization(row));
}
