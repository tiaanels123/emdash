import { eq, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { organizations } from '@main/db/schema';

/**
 * Persists a new ordering of organizations. Each id's sort order is set to its
 * index in the provided list. Ids not present in the list are left unchanged.
 */
export async function reorderOrganizations(orderedIds: string[]): Promise<void> {
  for (let index = 0; index < orderedIds.length; index++) {
    await db
      .update(organizations)
      .set({ sortOrder: index, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(organizations.id, orderedIds[index]));
  }
}
