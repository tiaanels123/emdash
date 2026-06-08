import { action, computed, makeObservable, observable, runInAction } from 'mobx';
import { rpc } from '@renderer/lib/ipc';
import { Resource } from '@renderer/lib/stores/resource';
import { log } from '@renderer/utils/logger';
import type { Result } from '@shared/lib/result';
import {
  type CreateOrganizationParams,
  type DeleteOrganizationOptions,
  type Organization,
  type OrganizationError,
  type UpdateOrganizationParams,
} from '@shared/organizations';

export type OrganizationManagerSnapshot = {
  activeOrganizationId: string | null;
};

/**
 * Holds the list of organizations and the currently active organization.
 * Projects, integrations, and provider config are all scoped to the active
 * organization. Mirrors the flat resource-backed store pattern used by
 * SshConnectionStore, with an added active-selection + snapshot persistence.
 */
export class OrganizationManagerStore {
  readonly organizationsResource: Resource<Organization[]>;

  activeOrganizationId: string | null = null;
  private pendingMutations = 0;

  constructor() {
    this.organizationsResource = new Resource<Organization[]>(
      () => rpc.organizations.listOrganizations(),
      []
    );

    makeObservable<OrganizationManagerStore, 'pendingMutations'>(this, {
      activeOrganizationId: observable,
      pendingMutations: observable,
      organizations: computed,
      activeOrganization: computed,
      activeId: computed,
      isLoading: computed,
      snapshot: computed,
      setActiveOrganization: action,
      restoreSnapshot: action,
      dispose: action,
    });
  }

  /** Organizations sorted by their persisted sort order. */
  get organizations(): Organization[] {
    return [...(this.organizationsResource.data ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
  }

  /**
   * The active organization. Falls back to the first organization when the
   * stored selection is missing or no longer exists, so there is always an
   * active organization once the list has loaded.
   */
  get activeOrganization(): Organization | null {
    const orgs = this.organizations;
    return orgs.find((org) => org.id === this.activeOrganizationId) ?? orgs[0] ?? null;
  }

  /** The active organization id, or null before the list has loaded. */
  get activeId(): string | null {
    return this.activeOrganization?.id ?? null;
  }

  get isLoading(): boolean {
    return this.organizationsResource.loading || this.pendingMutations > 0;
  }

  /** Loads the organization list. Safe to call once at bootstrap. */
  async load(): Promise<void> {
    await this.organizationsResource.load();
  }

  setActiveOrganization(organizationId: string): void {
    this.activeOrganizationId = organizationId;
    this.materializeActiveOrgMcp();
  }

  /**
   * Materializes the active organization's MCP servers onto the agents' on-disk
   * config files so spawned agents see the active org's servers. Fire-and-forget
   * — MCP server lists are otherwise read per-org from the database.
   */
  private materializeActiveOrgMcp(): void {
    const organizationId = this.activeId;
    if (!organizationId) return;
    void rpc.mcp
      .materialize(organizationId)
      .then((result) => {
        if (!result.success) {
          log.warn('Failed to materialize MCP servers for active organization', {
            organizationId,
            error: result.error,
          });
        }
      })
      .catch((error) => {
        log.warn('Failed to materialize MCP servers for active organization', {
          organizationId,
          error,
        });
      });
  }

  async createOrganization(params: CreateOrganizationParams): Promise<Organization> {
    return this.withMutation(async () => {
      const organization = await rpc.organizations.createOrganization(params);
      this.organizationsResource.setValue([
        ...(this.organizationsResource.data ?? []),
        organization,
      ]);
      runInAction(() => {
        this.activeOrganizationId = organization.id;
      });
      this.materializeActiveOrgMcp();
      return organization;
    });
  }

  async updateOrganization(
    id: string,
    params: UpdateOrganizationParams
  ): Promise<Result<Organization, OrganizationError>> {
    return this.withMutation(async () => {
      const result = await rpc.organizations.updateOrganization(id, params);
      if (result.success) {
        const current = this.organizationsResource.data ?? [];
        this.organizationsResource.setValue(
          current.map((org) => (org.id === id ? result.data : org))
        );
      }
      return result;
    });
  }

  async deleteOrganization(
    id: string,
    options?: DeleteOrganizationOptions
  ): Promise<Result<void, OrganizationError>> {
    return this.withMutation(async () => {
      const result = await rpc.organizations.deleteOrganization(id, options);
      if (result.success) {
        const current = this.organizationsResource.data ?? [];
        this.organizationsResource.setValue(current.filter((org) => org.id !== id));
        runInAction(() => {
          if (this.activeOrganizationId === id) {
            this.activeOrganizationId = null;
          }
        });
        // Active org fell back to another org — reflect its servers on disk.
        this.materializeActiveOrgMcp();
      }
      return result;
    });
  }

  async reorderOrganizations(orderedIds: string[]): Promise<void> {
    await this.withMutation(async () => {
      const byId = new Map((this.organizationsResource.data ?? []).map((org) => [org.id, org]));
      const reordered = orderedIds
        .map((id, index) => {
          const org = byId.get(id);
          return org ? { ...org, sortOrder: index } : undefined;
        })
        .filter((org): org is Organization => org !== undefined);
      this.organizationsResource.setValue(reordered);
      await rpc.organizations.reorderOrganizations(orderedIds);
    });
  }

  get snapshot(): OrganizationManagerSnapshot {
    return { activeOrganizationId: this.activeOrganizationId };
  }

  restoreSnapshot(snapshot: OrganizationManagerSnapshot | undefined): void {
    if (snapshot?.activeOrganizationId) {
      this.activeOrganizationId = snapshot.activeOrganizationId;
    }
  }

  dispose(): void {
    this.organizationsResource.dispose();
  }

  private async withMutation<T>(run: () => Promise<T>): Promise<T> {
    runInAction(() => {
      this.pendingMutations += 1;
    });
    try {
      return await run();
    } finally {
      runInAction(() => {
        this.pendingMutations = Math.max(0, this.pendingMutations - 1);
      });
    }
  }
}
