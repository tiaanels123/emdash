/**
 * Shared organization primitives used across the main and renderer processes.
 *
 * An organization is the top-level entity that groups projects (repositories)
 * and owns its own integration credentials and provider configuration. Every
 * project belongs to exactly one organization.
 */

/**
 * The fixed id of the default "Personal" organization. Existing installs are
 * migrated so that all pre-existing projects and integration credentials land
 * under this organization. It is also the DB-level default for
 * `projects.organization_id`, so the schema and the data migration agree on a
 * single well-known id.
 *
 * This is a constant (not a generated id) precisely so the migration is
 * idempotent and the column default can reference it.
 */
export const PERSONAL_ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';

/** Display name for the default organization created during migration. */
export const PERSONAL_ORGANIZATION_NAME = 'Personal';

export type Organization = {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  sortOrder: number;
  /** True for the default organization, which cannot be deleted. */
  isPersonal: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CreateOrganizationParams = {
  id?: string;
  name: string;
  color?: string | null;
  icon?: string | null;
};

export type UpdateOrganizationParams = {
  name?: string;
  color?: string | null;
  icon?: string | null;
  sortOrder?: number;
};

/** Whether the given organization id is the protected default organization. */
export function isPersonalOrganization(organizationId: string): boolean {
  return organizationId === PERSONAL_ORGANIZATION_ID;
}

/** Recoverable failures from organization operations, surfaced over RPC. */
export type OrganizationError =
  | { type: 'not_found'; message?: string }
  | { type: 'is_personal'; message?: string }
  | { type: 'not_empty'; projectCount: number; message?: string }
  | { type: 'invalid_name'; message?: string };

/** Options for deleting an organization. */
export type DeleteOrganizationOptions = {
  /** When true, delete the organization and all of its projects (and their data). */
  cascade?: boolean;
};
