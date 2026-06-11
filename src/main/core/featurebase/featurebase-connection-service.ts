import { encryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
import { orgScopedSecretKey } from '@main/core/secrets/org-scoped-secret-key';
import { log } from '@main/lib/logger';
import { ISSUE_PROVIDER_CAPABILITIES, type ConnectionStatus } from '@shared/issue-providers';
import { FeaturebaseClient, FeaturebaseHttpError } from './featurebase-client';

export const NOT_CONFIGURED_ERROR =
  'Featurebase is not configured. Connect Featurebase in settings.';

export function toFeaturebaseErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof FeaturebaseHttpError) {
    if (error.status === 401) {
      return 'Featurebase authentication failed. Check your API key.';
    }
    if (error.status === 403) {
      return 'Featurebase API key was accepted but is missing required permissions.';
    }
    if (error.status === 429) {
      return 'Featurebase API rate limit exceeded. Please try again shortly.';
    }
    if (error.status >= 500) {
      return 'Featurebase API is temporarily unavailable. Please try again.';
    }
    return error.message || fallback;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}

function isNotConfigured(error: unknown): boolean {
  return error instanceof Error && error.message === NOT_CONFIGURED_ERROR;
}

export class FeaturebaseConnectionService {
  private readonly FEATUREBASE_TOKEN_SECRET_KEY = 'emdash-featurebase-token';

  // Caches are keyed by organization id so each organization keeps its own
  // credential. `cachedTokens` short-circuits secret reads (absence = unloaded,
  // null = loaded-but-absent); `clients` memoizes one FeaturebaseClient per org
  // and is invalidated when that org's token rotates.
  private readonly cachedTokens = new Map<string, string | null>();
  private readonly clients = new Map<string, { client: FeaturebaseClient; token: string }>();

  private secretKey(organizationId: string): string {
    return orgScopedSecretKey(organizationId, this.FEATUREBASE_TOKEN_SECRET_KEY);
  }

  async saveToken(
    organizationId: string,
    token: string
  ): Promise<{ success: boolean; error?: string }> {
    const clean = token.trim();
    if (!clean) {
      return { success: false, error: 'Featurebase API key cannot be empty.' };
    }

    try {
      const client = this.getClientForToken(organizationId, clean);
      await this.validateToken(client);
      await this.storeToken(organizationId, clean);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: toFeaturebaseErrorMessage(error, 'Failed to validate Featurebase API key.'),
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
        error: toFeaturebaseErrorMessage(error, 'Failed to clear Featurebase API key.'),
      };
    }
  }

  async checkConnection(organizationId: string): Promise<ConnectionStatus> {
    try {
      const token = await this.getStoredToken(organizationId);
      if (!token) {
        return {
          connected: false,
          capabilities: ISSUE_PROVIDER_CAPABILITIES.featurebase,
        };
      }

      const client = this.getClientForToken(organizationId, token);
      await this.validateToken(client);

      return {
        connected: true,
        capabilities: ISSUE_PROVIDER_CAPABILITIES.featurebase,
      };
    } catch (error) {
      if (isNotConfigured(error)) {
        return {
          connected: false,
          capabilities: ISSUE_PROVIDER_CAPABILITIES.featurebase,
        };
      }

      return {
        connected: false,
        error: toFeaturebaseErrorMessage(error, 'Failed to verify Featurebase connection.'),
        capabilities: ISSUE_PROVIDER_CAPABILITIES.featurebase,
      };
    }
  }

  async getClient(organizationId: string): Promise<FeaturebaseClient | null> {
    const token = await this.getStoredToken(organizationId);
    if (!token) {
      return null;
    }

    return this.getClientForToken(organizationId, token);
  }

  private getClientForToken(organizationId: string, token: string): FeaturebaseClient {
    const cached = this.clients.get(organizationId);
    if (cached && cached.token === token) {
      return cached.client;
    }
    const client = new FeaturebaseClient(token);
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
      log.error('Failed to read Featurebase token from secure storage:', error);
      return null;
    }
  }

  private async validateToken(client: FeaturebaseClient): Promise<void> {
    await client.get('/v2/posts', { limit: 1 });
  }
}

export const featurebaseConnectionService = new FeaturebaseConnectionService();
