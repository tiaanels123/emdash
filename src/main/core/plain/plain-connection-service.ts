import {
  AuthenticationError,
  ForbiddenError,
  PlainClient,
  PlainError,
  RateLimitError,
} from '@team-plain/graphql';
import { encryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
import { orgScopedSecretKey } from '@main/core/secrets/org-scoped-secret-key';
import { log } from '@main/lib/logger';
import { ISSUE_PROVIDER_CAPABILITIES, type ConnectionStatus } from '@shared/issue-providers';

const NOT_CONFIGURED_ERROR = 'Plain is not configured. Connect Plain in settings.';

export function toPlainErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof AuthenticationError) {
    return error.message || 'Plain authentication failed. Check your API key.';
  }
  if (error instanceof ForbiddenError) {
    return error.message || 'Plain API key was accepted but is missing required permissions.';
  }
  if (error instanceof RateLimitError) {
    return 'Plain API rate limit exceeded. Please try again shortly.';
  }
  if (error instanceof PlainError && error.message) {
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

function isNotConfigured(error: unknown): boolean {
  return error instanceof Error && error.message === NOT_CONFIGURED_ERROR;
}

export class PlainConnectionService {
  private readonly PLAIN_TOKEN_SECRET_KEY = 'emdash-plain-token';

  // Caches are keyed by organization id so each organization keeps its own
  // credential. `cachedTokens` short-circuits secret reads (absence = unloaded,
  // null = loaded-but-absent); `clients` memoizes one PlainClient per org and
  // is invalidated when that org's token rotates.
  private readonly cachedTokens = new Map<string, string | null>();
  private readonly clients = new Map<string, { client: PlainClient; token: string }>();

  private secretKey(organizationId: string): string {
    return orgScopedSecretKey(organizationId, this.PLAIN_TOKEN_SECRET_KEY);
  }

  async saveToken(
    organizationId: string,
    token: string
  ): Promise<{ success: boolean; error?: string }> {
    const clean = token.trim();
    if (!clean) {
      return { success: false, error: 'Plain API key cannot be empty.' };
    }

    try {
      const client = this.getClientForToken(organizationId, clean);
      await this.validateToken(client);
      await this.storeToken(organizationId, clean);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: toPlainErrorMessage(error, 'Failed to validate Plain API key.'),
      };
    }
  }

  async clearToken(organizationId: string): Promise<{ success: boolean; error?: string }> {
    try {
      await encryptedAppSecretsStore.deleteSecret(this.secretKey(organizationId));
      this.cachedTokens.set(organizationId, null);
      this.clients.delete(organizationId);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: toPlainErrorMessage(error, 'Failed to clear Plain API key.'),
      };
    }
  }

  async checkConnection(organizationId: string): Promise<ConnectionStatus> {
    try {
      const token = await this.getStoredToken(organizationId);
      if (!token) {
        return {
          connected: false,
          capabilities: ISSUE_PROVIDER_CAPABILITIES.plain,
        };
      }

      const client = this.getClientForToken(organizationId, token);
      await this.validateToken(client);

      return {
        connected: true,
        capabilities: ISSUE_PROVIDER_CAPABILITIES.plain,
      };
    } catch (error) {
      if (isNotConfigured(error)) {
        return {
          connected: false,
          capabilities: ISSUE_PROVIDER_CAPABILITIES.plain,
        };
      }

      return {
        connected: false,
        error: toPlainErrorMessage(error, 'Failed to verify Plain connection.'),
        capabilities: ISSUE_PROVIDER_CAPABILITIES.plain,
      };
    }
  }

  async getClient(organizationId: string): Promise<PlainClient | null> {
    const token = await this.getStoredToken(organizationId);
    if (!token) {
      return null;
    }

    return this.getClientForToken(organizationId, token);
  }

  private getClientForToken(organizationId: string, token: string): PlainClient {
    const cached = this.clients.get(organizationId);
    if (cached && cached.token === token) {
      return cached.client;
    }
    const client = new PlainClient({ apiKey: token });
    this.clients.set(organizationId, { client, token });
    return client;
  }

  private async storeToken(organizationId: string, token: string): Promise<void> {
    await encryptedAppSecretsStore.setSecret(this.secretKey(organizationId), token);
    this.cachedTokens.set(organizationId, token);
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
      log.error('Failed to read Plain token from secure storage:', error);
      return null;
    }
  }

  private async validateToken(client: PlainClient): Promise<void> {
    try {
      await client.query.threads({ first: 1 });
    } catch (error) {
      if (
        error instanceof ForbiddenError ||
        error instanceof AuthenticationError ||
        error instanceof RateLimitError ||
        error instanceof PlainError
      ) {
        throw error;
      }
      if (error instanceof Error) {
        throw new PlainError(error.message);
      }
      throw new PlainError(NOT_CONFIGURED_ERROR);
    }
  }
}

export const plainConnectionService = new PlainConnectionService();
