import { getProjectOrganizationId } from '@main/core/projects/operations/getProjects';
import { projectManager } from '@main/core/projects/project-manager';
import type {
  ConnectionStatus,
  ConnectionStatusMap,
  IssueProviderType,
} from '@shared/issue-providers';
import { createRPCController } from '@shared/lib/ipc/rpc';
import type {
  IssueContextOpts,
  IssueProvider,
  IssueQueryOpts,
  IssueSearchOpts,
} from './issue-provider';
import { getAllIssueProviders, getIssueProvider } from './registry';

const DEFAULT_CAPABILITIES = {
  requiresProjectPath: false,
  requiresRepositoryUrl: false,
  supportsIssueContext: false,
} as const;

const CONNECTION_CHECK_TIMEOUT_MS = 8_000;

function timeoutStatus(provider: IssueProvider): ConnectionStatus {
  return {
    connected: false,
    error: `Connection check timed out after ${CONNECTION_CHECK_TIMEOUT_MS}ms.`,
    capabilities: provider.capabilities,
  };
}

function failureStatus(provider: IssueProvider, error: unknown): ConnectionStatus {
  const message = error instanceof Error ? error.message : 'Connection check failed.';
  return {
    connected: false,
    error: message,
    capabilities: provider.capabilities,
  };
}

async function checkProviderConnection(
  provider: IssueProvider,
  organizationId: string
): Promise<ConnectionStatus> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<ConnectionStatus>((resolve) => {
    timeoutId = setTimeout(() => {
      resolve(timeoutStatus(provider));
    }, CONNECTION_CHECK_TIMEOUT_MS);
  });

  try {
    return await Promise.race([provider.checkConnection(organizationId), timeoutPromise]);
  } catch (error) {
    return failureStatus(provider, error);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Enriches issue query opts with the resolved organization (from the project)
 * and the project's base remote. The organization scopes which credentials the
 * provider reads; this is the operation-resolution path, so the org comes from
 * the project, not the active organization.
 */
async function withResolvedRemote<T extends IssueQueryOpts>(opts: T): Promise<T> {
  const organizationId = opts.organizationId ?? (await getProjectOrganizationId(opts.projectId));
  const resolved = { ...opts, organizationId };
  if (!opts.projectId) return resolved;
  const project = projectManager.getProject(opts.projectId);
  if (!project) return resolved;

  const remote = await project.repository.getBaseRemote().catch(() => undefined);
  return { ...resolved, remote };
}

export const issueController = createRPCController({
  checkConnection: async (provider: IssueProviderType, organizationId: string) => {
    const issueProvider = getIssueProvider(provider);
    if (!issueProvider) {
      return {
        connected: false,
        error: `Unknown provider: ${provider}`,
        capabilities: DEFAULT_CAPABILITIES,
      };
    }

    return checkProviderConnection(issueProvider, organizationId);
  },

  checkAllConnections: async (organizationId: string): Promise<ConnectionStatusMap> => {
    const providers = getAllIssueProviders();

    const settled = await Promise.all(
      providers.map(async (provider) => {
        const status = await checkProviderConnection(provider, organizationId);
        return [provider.type, status] as const;
      })
    );

    return Object.fromEntries(settled) as ConnectionStatusMap;
  },

  listIssues: async (provider: IssueProviderType, opts: IssueQueryOpts) => {
    const issueProvider = getIssueProvider(provider);
    if (!issueProvider) {
      return { success: false, error: `Unknown provider: ${provider}` } as const;
    }

    return issueProvider.listIssues(await withResolvedRemote(opts));
  },

  searchIssues: async (provider: IssueProviderType, opts: IssueSearchOpts) => {
    const issueProvider = getIssueProvider(provider);
    if (!issueProvider) {
      return { success: false, error: `Unknown provider: ${provider}` } as const;
    }

    return issueProvider.searchIssues(await withResolvedRemote(opts));
  },

  getIssueContext: async (provider: IssueProviderType, opts: IssueContextOpts) => {
    const issueProvider = getIssueProvider(provider);
    if (!issueProvider) {
      return { success: false, error: `Unknown provider: ${provider}` } as const;
    }

    if (!issueProvider.getIssueContext) {
      return { success: false, error: `${provider} does not support issue context.` } as const;
    }

    return issueProvider.getIssueContext(await withResolvedRemote(opts));
  },
});
