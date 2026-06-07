import type { OrganizationRow } from '@main/db/schema';
import { type Organization, isPersonalOrganization } from '@shared/organizations';

/** Maps a database row to the shared {@link Organization} DTO. */
export function toOrganization(row: OrganizationRow): Organization {
  return {
    id: row.id,
    name: row.name,
    color: row.color ?? null,
    icon: row.icon ?? null,
    sortOrder: row.sortOrder,
    isPersonal: isPersonalOrganization(row.id),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
