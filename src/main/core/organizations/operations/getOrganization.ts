import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { organizations } from '@main/db/schema';
import type { Organization } from '@shared/organizations';
import { toOrganization } from '../organization-row';

/** Returns a single organization by id, or undefined when it does not exist. */
export async function getOrganization(id: string): Promise<Organization | undefined> {
  const [row] = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
  return row ? toOrganization(row) : undefined;
}
