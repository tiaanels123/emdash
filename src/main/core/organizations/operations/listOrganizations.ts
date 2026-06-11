import { asc } from 'drizzle-orm';
import { db } from '@main/db/client';
import { organizations } from '@main/db/schema';
import type { Organization } from '@shared/organizations';
import { toOrganization } from '../organization-row';

/** Lists all organizations ordered by their sort order, then creation time. */
export async function listOrganizations(): Promise<Organization[]> {
  const rows = await db
    .select()
    .from(organizations)
    .orderBy(asc(organizations.sortOrder), asc(organizations.createdAt));
  return rows.map(toOrganization);
}
