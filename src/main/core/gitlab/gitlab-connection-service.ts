import { GitbeakerRequestError, Gitlab } from '@gitbeaker/rest';
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

interface GitLabConnectionConfig {
  instanceUrl: string;
}

interface GitLabKVSchema extends Record<string, unknown> {
  connection: GitLabConnectionConfig;
}

// The KV store is namespaced per organization so each organization keeps its own
// connection config (instance URL). Tokens live in the encrypted secrets store
// under an org-scoped key.
function gitlabKVFor(organizationId: string): KV<GitLabKVSchema> {
  return new KV<GitLabKVSchema>(`gitlab:${organizationId}`);
}

const NOT_CONFIGURED_ERROR = 'GitLab is not configured. Connect GitLab in settings.';

export function toGitLabErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof GitbeakerRequestError) {
    const status = error.cause?.response?.status;
    if (status === 401 || status === 403) {
      return 'GitLab authentication failed. Check your token permissions.';
    }
    if (status === 404) {
      return 'GitLab project or resource not found.';
    }
    if (status === 429) {
      return 'GitLab API rate limit exceeded. Please try again shortly.';
    }
    if (typeof status === 'number' && status >= 500) {
      return 'GitLab API is temporarily unavailable. Please try again.';
    }
    return error.message || fallback;
  }

  if (hasKnownNetworkErrorCode(error)) {
    return 'Unable to reach GitLab instance. Check your URL and network connection.';
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}

function isNotConfigured(error: unknown): boolean {
  return error instanceof Error && error.message === NOT_CONFIGURED_ERROR;
}

export class GitLabConnectionService {
  private readonly GITLAB_TOKEN_SECRET_KEY = 'emdash-gitlab-token';

  // Cached clients are keyed by organization id so each organization keeps its
  // own GitLab client; each entry memoizes the client alongside the
  // `${instanceUrl}|${token}` key it was built from so it can be invalidated
  // when that org's credentials rotate.
  private readonly clients = new Map<string, { client: Gitlab; key: string }>();

  private secretKey(organizationId: string): string {
    return orgScopedSecretKey(organizationId, this.GITLAB_TOKEN_SECRET_KEY);
  }

  async saveCredentials(
    organizationId: string,
    instanceUrl: string,
    token: string
  ): Promise<{ success: boolean; username?: string; displayName?: string; error?: string }> {
    const normalizedUrl = normalizeHostedInstanceUrl(instanceUrl);
    if (!normalizedUrl) {
      return { success: false, error: 'A valid GitLab instance URL is required.' };
    }

    const cleanToken = token.trim();
    if (!cleanToken) {
      return { success: false, error: 'A GitLab API token is required.' };
    }

    try {
      const client = this.getClientForCredentials(organizationId, normalizedUrl, cleanToken);
      const user = (await client.Users.showCurrentUser()) as Record<string, unknown>;

      await encryptedAppSecretsStore.setSecret(this.secretKey(organizationId), cleanToken);
      await this.writeConnection(organizationId, { instanceUrl: normalizedUrl });

      const username = this.readString(user.username) ?? undefined;
      const displayName = this.readString(user.name) ?? username;

      return { success: true, username, displayName };
    } catch (error) {
      return {
        success: false,
        error: toGitLabErrorMessage(error, 'Failed to validate GitLab credentials.'),
      };
    }
  }

  async clearCredentials(organizationId: string): Promise<{ success: boolean; error?: string }> {
    try {
      await encryptedAppSecretsStore.deleteSecret(this.secretKey(organizationId));
      await gitlabKVFor(organizationId).del('connection');

      this.clients.delete(organizationId);

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: toGitLabErrorMessage(error, 'Failed to clear GitLab credentials.'),
      };
    }
  }

  async checkConnection(organizationId: string): Promise<ConnectionStatus> {
    try {
      const { client } = await this.requireAuth(organizationId);
      const user = (await client.Users.showCurrentUser()) as Record<string, unknown>;

      const username = this.readString(user.username) ?? undefined;
      const displayName = this.readString(user.name) ?? username;

      return {
        connected: true,
        displayName,
        capabilities: ISSUE_PROVIDER_CAPABILITIES.gitlab,
      };
    } catch (error) {
      if (isNotConfigured(error)) {
        return {
          connected: false,
          capabilities: ISSUE_PROVIDER_CAPABILITIES.gitlab,
        };
      }

      return {
        connected: false,
        error: toGitLabErrorMessage(error, 'Failed to verify GitLab connection.'),
        capabilities: ISSUE_PROVIDER_CAPABILITIES.gitlab,
      };
    }
  }

  async getClient(organizationId: string): Promise<Gitlab | null> {
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

  async resolveProject(
    organizationId: string,
    projectPath: string,
    remoteName?: string
  ): Promise<{ client: Gitlab; projectId: number; projectName: string | null }> {
    const { instanceUrl, client } = await this.requireAuth(organizationId);

    try {
      const remote = await resolvePreferredRemote(projectPath, remoteName);

      assertRemoteHostMatchesInstance(remote.host, instanceUrl, 'GitLab');

      const project = (await client.Projects.show(remote.slug)) as Record<string, unknown>;
      const projectId = this.readNumber(project.id);
      if (projectId === null) {
        throw new Error('Unable to resolve GitLab project ID.');
      }

      const projectName = this.readString(project.name);

      return {
        client,
        projectId,
        projectName,
      };
    } catch (error) {
      throw new Error(
        toGitLabErrorMessage(error, 'Unable to resolve GitLab project from the selected remote.')
      );
    }
  }

  private async requireAuth(
    organizationId: string
  ): Promise<{ instanceUrl: string; client: Gitlab }> {
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
  ): Gitlab {
    const key = `${instanceUrl}|${token}`;
    const cached = this.clients.get(organizationId);
    if (cached && cached.key === key) {
      return cached.client;
    }
    const client = new Gitlab({ host: instanceUrl, token });
    this.clients.set(organizationId, { client, key });
    return client;
  }

  private async writeConnection(
    organizationId: string,
    connection: GitLabConnectionConfig
  ): Promise<void> {
    await gitlabKVFor(organizationId).set('connection', connection);
  }

  private async readConnection(organizationId: string): Promise<GitLabConnectionConfig | null> {
    const connection = await gitlabKVFor(organizationId).get('connection');
    const instanceUrl = this.readString(connection?.instanceUrl);
    if (!instanceUrl) return null;
    return { instanceUrl };
  }

  private readString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private readNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  }
}

export const gitLabConnectionService = new GitLabConnectionService();
