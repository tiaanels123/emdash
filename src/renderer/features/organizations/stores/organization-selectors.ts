import { appState } from '@renderer/lib/stores/app-state';
import { type Organization, PERSONAL_ORGANIZATION_ID } from '@shared/organizations';
import type { OrganizationManagerStore } from './organization-manager';

/** Returns the OrganizationManagerStore from appState. */
export function getOrganizationManagerStore(): OrganizationManagerStore {
  return appState.organizations;
}

/**
 * The active organization. Call only inside `observer` components (or other
 * MobX reactions) to stay reactive.
 */
export function getActiveOrganization(): Organization | null {
  return getOrganizationManagerStore().activeOrganization;
}

/**
 * The active organization id, falling back to the Personal organization before
 * the list has loaded. Safe to call imperatively (e.g. when creating a project).
 */
export function getActiveOrganizationId(): string {
  return getOrganizationManagerStore().activeId ?? PERSONAL_ORGANIZATION_ID;
}
