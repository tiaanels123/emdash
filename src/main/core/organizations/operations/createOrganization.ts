import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { organizations } from '@main/db/schema';
import { type CreateOrganizationParams, type Organization } from '@shared/organizations';
import { toOrganization } from '../organization-row';

/**
 * Creates a new organization. New organizations are appended after the existing
 * ones (highest sort order). The name is trimmed; empty names are rejected.
 */
export async function createOrganization(params: CreateOrganizationParams): Promise<Organization> {
  const name = params.name.trim();
  if (!name) {
    throw new Error('Organization name must not be empty');
  }

  const [{ nextSortOrder }] = await db
    .select({ nextSortOrder: sql<number>`COALESCE(MAX(${organizations.sortOrder}), -1) + 1` })
    .from(organizations);

  const [row] = await db
    .insert(organizations)
    .values({
      id: params.id ?? randomUUID(),
      name,
      color: params.color ?? null,
      icon: params.icon ?? null,
      sortOrder: nextSortOrder,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .returning();

  return toOrganization(row);
}
