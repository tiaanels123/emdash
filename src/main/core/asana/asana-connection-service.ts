import { encryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
import { orgScopedSecretKey } from '@main/core/secrets/org-scoped-secret-key';
import { log } from '@main/lib/logger';
import { telemetryService } from '@main/lib/telemetry';
import { ISSUE_PROVIDER_CAPABILITIES, type ConnectionStatus } from '@shared/issue-providers';
import { AsanaClient, AsanaHttpError } from './asana-client';

export const NOT_CONFIGURED_ERROR = 'Asana is not configured. Connect Asana in settings.';

export type AsanaWorkspace = {
  gid: string;
  name: string;
};

type AsanaUserResponse = {
  data?: {
    gid?: string;
    name?: string;
    workspaces?: AsanaWorkspace[];
  };
};

export function toAsanaErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof AsanaHttpError) {
    if (error.status === 401) {
      return 'Asana authentication failed. Check your access token.';
    }
    if (error.status === 403) {
      return 'Asana token was accepted but is missing required permissions.';
    }
    if (error.status === 429) {
      return 'Asana API rate limit exceeded. Please try again shortly.';
    }
    if (error.status >= 500) {
      return 'Asana API is temporarily unavailable. Please try again.';
    }
    return error.message || fallback;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}

export class AsanaConnectionService {
  private readonly ASANA_TOKEN_SECRET_KEY = 'emdash-asana-token';

  // Caches are keyed by organization id so each organization keeps its own
  // credential. `cachedTokens` short-circuits secret reads (absence = unloaded,
  // null = loaded-but-absent); `cachedWorkspaceGids` memoizes the primary
  // workspace per org and is reset when that org's token rotates; `clients`
  // memoizes one AsanaClient per org keyed alongside the token it was built for.
  private readonly cachedTokens = new Map<string, string | null>();
  private readonly cachedWorkspaceGids = new Map<string, string | null>();
  private readonly clients = new Map<string, { client: AsanaClient; token: string }>();

  private secretKey(organizationId: string): string {
    return orgScopedSecretKey(organizationId, this.ASANA_TOKEN_SECRET_KEY);
  }

  async saveToken(
    organizationId: string,
    token: string
  ): Promise<{ success: boolean; workspaceName?: string; error?: string }> {
    const clean = token.trim();
    if (!clean) {
      return { success: false, error: 'Asana access token cannot be empty.' };
    }

    try {
      const client = this.getClientForToken(organizationId, clean);
      const user = await this.fetchUser(client);
      await this.storeToken(organizationId, clean);
      this.cachedWorkspaceGids.set(organizationId, user.workspaces?.[0]?.gid ?? null);
      telemetryService.capture('integration_connected', { provider: 'asana' });

      return {
        success: true,
        workspaceName: user.workspaces?.[0]?.name ?? user.name,
      };
    } catch (error) {
      return {
        success: false,
        error: toAsanaErrorMessage(error, 'Failed to validate Asana access token.'),
      };
    }
  }

  async clearToken(organizationId: string): Promise<{ success: boolean; error?: string }> {
    try {
      await encryptedAppSecretsStore.deleteSecret(this.secretKey(organizationId));
      this.cachedTokens.set(organizationId, null);
      this.cachedWorkspaceGids.delete(organizationId);
      this.clients.delete(organizationId);
      telemetryService.capture('integration_disconnected', { provider: 'asana' });
      return { success: true };
    } catch (error) {
      log.error('Failed to clear Asana token:', error);
      return {
        success: false,
        error: 'Unable to remove Asana token from secure storage.',
      };
    }
  }

  async checkConnection(organizationId: string): Promise<ConnectionStatus> {
    try {
      const token = await this.getStoredToken(organizationId);
      if (!token) {
        return {
          connected: false,
          capabilities: ISSUE_PROVIDER_CAPABILITIES.asana,
        };
      }

      const client = this.getClientForToken(organizationId, token);
      const user = await this.fetchUser(client);

      return {
        connected: true,
        displayName: user.workspaces?.[0]?.name ?? user.name,
        capabilities: ISSUE_PROVIDER_CAPABILITIES.asana,
      };
    } catch (error) {
      return {
        connected: false,
        error: toAsanaErrorMessage(error, 'Failed to verify Asana connection.'),
        capabilities: ISSUE_PROVIDER_CAPABILITIES.asana,
      };
    }
  }

  async getClient(organizationId: string): Promise<AsanaClient | null> {
    const token = await this.getStoredToken(organizationId);
    if (!token) {
      return null;
    }
    return this.getClientForToken(organizationId, token);
  }

  async getPrimaryWorkspaceGid(organizationId: string): Promise<string | null> {
    const client = await this.getClient(organizationId);
    if (!client) return null;
    const cached = this.cachedWorkspaceGids.get(organizationId);
    if (cached !== undefined) return cached;

    const user = await this.fetchUser(client);
    const workspaceGid = user.workspaces?.[0]?.gid ?? null;
    this.cachedWorkspaceGids.set(organizationId, workspaceGid);
    return workspaceGid;
  }

  private async fetchUser(client: AsanaClient): Promise<{
    gid?: string;
    name?: string;
    workspaces?: AsanaWorkspace[];
  }> {
    const response = await client.get<AsanaUserResponse>('/users/me', {
      opt_fields: 'name,workspaces.gid,workspaces.name',
    });
    return response.data ?? {};
  }

  private getClientForToken(organizationId: string, token: string): AsanaClient {
    const cached = this.clients.get(organizationId);
    if (cached && cached.token === token) {
      return cached.client;
    }
    const client = new AsanaClient(token);
    this.clients.set(organizationId, { client, token });
    this.cachedWorkspaceGids.delete(organizationId);
    return client;
  }

  private async storeToken(organizationId: string, token: string): Promise<void> {
    try {
      await encryptedAppSecretsStore.setSecret(this.secretKey(organizationId), token);
      this.cachedTokens.set(organizationId, token);
    } catch (error) {
      log.error('Failed to store Asana token:', error);
      throw new Error('Unable to store Asana token securely.');
    }
  }

  private async getStoredToken(organizationId: string): Promise<string | null> {
    const cached = this.cachedTokens.get(organizationId);
    if (cached) {
      return cached;
    }

    try {
      const token = await encryptedAppSecretsStore.getSecret(this.secretKey(organizationId));
      this.cachedTokens.set(organizationId, token);
      return token;
    } catch (error) {
      log.error('Failed to read Asana token from secure storage:', error);
      return null;
    }
  }
}

export const asanaConnectionService = new AsanaConnectionService();
