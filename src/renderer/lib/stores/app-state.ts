import { OrganizationManagerStore } from '@renderer/features/organizations/stores/organization-manager';
import { ProjectManagerStore } from '@renderer/features/projects/stores/project-manager';
import { SidebarStore } from '@renderer/features/sidebar/sidebar-store';
import { DependenciesStore } from './dependencies-store';
import { NavigationHistoryStore } from './navigation-history-store';
import { NavigationStore } from './navigation-store';
import { ResourceMonitorStore } from './resource-monitor-store';
import { snapshotRegistry, type SnapshotRegistry } from './snapshot-registry';
import { SshConnectionStore } from './ssh-connection-store';
import { UpdateStore } from './update-store';

class AppState {
  readonly update: UpdateStore;
  readonly organizations: OrganizationManagerStore;
  readonly projects: ProjectManagerStore;
  readonly sidebar: SidebarStore;
  readonly snapshots: SnapshotRegistry;
  readonly history: NavigationHistoryStore;
  readonly navigation: NavigationStore;
  readonly dependencies: DependenciesStore;
  readonly sshConnections: SshConnectionStore;
  readonly resourceMonitor: ResourceMonitorStore;

  constructor() {
    this.snapshots = snapshotRegistry;
    this.update = new UpdateStore();
    // Organizations sit above projects; construct first so project-scoped code
    // can read the active organization.
    this.organizations = new OrganizationManagerStore();
    this.projects = new ProjectManagerStore();
    this.sidebar = new SidebarStore(this.projects);
    this.history = new NavigationHistoryStore();
    this.navigation = new NavigationStore();
    this.dependencies = new DependenciesStore();
    this.sshConnections = new SshConnectionStore({
      onConnectionReady: (connectionId) =>
        void this.dependencies.refreshAgents(connectionId, { refreshShellEnv: false }),
    });
    this.resourceMonitor = new ResourceMonitorStore();
    snapshotRegistry.register('navigation', () => this.navigation.snapshot);
    snapshotRegistry.register('sidebar', () => this.sidebar.snapshot);
    snapshotRegistry.register('organizations', () => this.organizations.snapshot);
    this.dependencies.start();
    this.sshConnections.start();
  }
}

export const appState = new AppState();

// Re-export for callers that previously imported sidebarStore from sidebar-store.ts.
export const sidebarStore = appState.sidebar;
