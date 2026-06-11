import { userGetCurrent } from '@llamaduck/forgejo-ts';
import { createClient, type Client } from '@llamaduck/forgejo-ts/client';
import { AxiosError } from 'axios';
import { resolvePreferredRemote } from '@main/core/issues/git-remote-resolver';
import {
  assertRemoteHostMatchesInstance,
  hasKnownNetworkErrorCode,
  normalizeHostedInstanceUrl,
} from '@main/core/issues/helpers/hosted-instance';
import { encryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
import { orgScopedSecretKey } from '@main/core/secrets/org-scoped-secret-key';
import { KV } from '@main/db/kv';
import { ISSUE_PROVIDER_CAPABILITIES, type ConnectionStatus } from '@shared/issue-providers';

interface ForgejoConnectionConfig {
  instanceUrl: string;
}

interface ForgejoKVSchema extends Record<string, unknown> {
  connection: ForgejoConnectionConfig;
}

const NOT_CONFIGURED_ERROR = 'Forgejo is not configured. Connect Forgejo in settings.';

export function toForgejoErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof AxiosError) {
    const status = error.response?.status;
    if (status === 401 || status === 403) {
      return 'Forgejo authentication failed. Check your token permissions.';
    }
    if (status === 404) {
      return 'Forgejo repository or resource not found.';
    }
    if (status === 429) {
      return 'Forgejo API rate limit exceeded. Please try again shortly.';
    }
    if (typeof status === 'number' && status >= 500) {
      return 'Forgejo API is temporarily unavailable. Please try again.';
    }
    return error.message || fallback;
  }

  if (hasKnownNetworkErrorCode(error)) {
    return 'Unable to reach Forgejo instance. Check your URL and network connection.';
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}

function isNotConfigured(error: unknown): boolean {
  return error instanceof Error && error.message === NOT_CONFIGURED_ERROR;
}

export class ForgejoConnectionService {
  private readonly FORGEJO_TOKEN_SECRET_KEY = 'emdash-forgejo-token';

  // Caches are keyed by organization id so each organization keeps its own
  // credential. `clients` memoizes one Forgejo client per org and is invalidated
  // when that org's instanceUrl/token rotates; `kvs` memoizes the per-org KV
  // namespace so connection config stays isolated between organizations.
  private readonly clients = new Map<string, { client: Client; key: string }>();
  private readonly kvs = new Map<string, KV<ForgejoKVSchema>>();

  private secretKey(organizationId: string): string {
    return orgScopedSecretKey(organizationId, this.FORGEJO_TOKEN_SECRET_KEY);
  }

  private kv(organizationId: string): KV<ForgejoKVSchema> {
    const cached = this.kvs.get(organizationId);
    if (cached) {
      return cached;
    }
    const kv = new KV<ForgejoKVSchema>(`forgejo:${organizationId}`);
    this.kvs.set(organizationId, kv);
    return kv;
  }

  async saveCredentials(
    organizationId: string,
    instanceUrl: string,
    token: string
  ): Promise<{ success: boolean; username?: string; displayName?: string; error?: string }> {
    const normalizedUrl = normalizeHostedInstanceUrl(instanceUrl);
    if (!normalizedUrl) {
      return { success: false, error: 'A valid Forgejo instance URL is required.' };
    }

    const cleanToken = token.trim();
    if (!cleanToken) {
      return { success: false, error: 'A Forgejo API token is required.' };
    }

    try {
      const client = this.getClientForCredentials(organizationId, normalizedUrl, cleanToken);
      const { data: user } = await userGetCurrent({ client, throwOnError: true });

      await encryptedAppSecretsStore.setSecret(this.secretKey(organizationId), cleanToken);
      await this.writeConnection(organizationId, { instanceUrl: normalizedUrl });

      const username = user?.login ?? undefined;
      const displayName = user?.full_name || username;

      return { success: true, username, displayName };
    } catch (error) {
      return {
        success: false,
        error: toForgejoErrorMessage(error, 'Failed to validate Forgejo credentials.'),
      };
    }
  }

  async clearCredentials(organizationId: string): Promise<{ success: boolean; error?: string }> {
    try {
      await encryptedAppSecretsStore.deleteSecret(this.secretKey(organizationId));
      await this.kv(organizationId).del('connection');

      this.clients.delete(organizationId);

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: toForgejoErrorMessage(error, 'Failed to clear Forgejo credentials.'),
      };
    }
  }

  async checkConnection(organizationId: string): Promise<ConnectionStatus> {
    try {
      const { client } = await this.requireAuth(organizationId);
      const { data: user } = await userGetCurrent({ client, throwOnError: true });

      const username = user?.login ?? undefined;
      const displayName = user?.full_name || username;

      return {
        connected: true,
        displayName,
        capabilities: ISSUE_PROVIDER_CAPABILITIES.forgejo,
      };
    } catch (error) {
      if (isNotConfigured(error)) {
        return {
          connected: false,
          capabilities: ISSUE_PROVIDER_CAPABILITIES.forgejo,
        };
      }

      return {
        connected: false,
        error: toForgejoErrorMessage(error, 'Failed to verify Forgejo connection.'),
        capabilities: ISSUE_PROVIDER_CAPABILITIES.forgejo,
      };
    }
  }

  async getClient(organizationId: string): Promise<Client | null> {
    try {
      const { client } = await this.requireAuth(organizationId);
      return client;
    } catch (error) {
      if (isNotConfigured(error)) {
        return null;
      }
      throw error;
    }
  }

  async resolveRepo(
    organizationId: string,
    projectPath: string,
    remoteName?: string
  ): Promise<{ client: Client; owner: string; repo: string; repoName: string }> {
    const { instanceUrl, client } = await this.requireAuth(organizationId);
    const remote = await resolvePreferredRemote(projectPath, remoteName);

    assertRemoteHostMatchesInstance(remote.host, instanceUrl, 'Forgejo');

    const parts = remote.slug.split('/');
    if (parts.length < 2) {
      throw new Error('Unable to extract owner/repo from remote URL.');
    }

    const owner = parts[0];
    const repo = parts.slice(1).join('/');

    return { client, owner, repo, repoName: repo };
  }

  private async requireAuth(
    organizationId: string
  ): Promise<{ instanceUrl: string; client: Client }> {
    const connection = await this.readConnection(organizationId);
    if (!connection) {
      throw new Error(NOT_CONFIGURED_ERROR);
    }

    const token = await encryptedAppSecretsStore.getSecret(this.secretKey(organizationId));
    if (!token) {
      throw new Error(NOT_CONFIGURED_ERROR);
    }

    return {
      instanceUrl: connection.instanceUrl,
      client: this.getClientForCredentials(organizationId, connection.instanceUrl, token),
    };
  }

  private getClientForCredentials(
    organizationId: string,
    instanceUrl: string,
    token: string
  ): Client {
    const key = `${instanceUrl}|${token}`;
    const cached = this.clients.get(organizationId);
    if (cached && cached.key === key) {
      return cached.client;
    }

    const client = createClient({
      baseURL: `${instanceUrl}/api/v1`,
      headers: {
        Authorization: `token ${token}`,
      },
    });
    this.clients.set(organizationId, { client, key });

    return client;
  }

  private async writeConnection(
    organizationId: string,
    connection: ForgejoConnectionConfig
  ): Promise<void> {
    await this.kv(organizationId).set('connection', connection);
  }

  private async readConnection(organizationId: string): Promise<ForgejoConnectionConfig | null> {
    const connection = await this.kv(organizationId).get('connection');
    if (typeof connection?.instanceUrl !== 'string' || !connection.instanceUrl.trim()) return null;
    return { instanceUrl: connection.instanceUrl };
  }
}

export const forgejoConnectionService = new ForgejoConnectionService();
