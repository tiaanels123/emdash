import { LinearClient } from '@linear/sdk';
import { encryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
import { orgScopedSecretKey } from '@main/core/secrets/org-scoped-secret-key';
import { log } from '@main/lib/logger';
import { telemetryService } from '@main/lib/telemetry';
import { ISSUE_PROVIDER_CAPABILITIES, type ConnectionStatus } from '@shared/issue-providers';

export class LinearConnectionService {
  private readonly LINEAR_TOKEN_SECRET_KEY = 'emdash-linear-token';

  // Caches are keyed by organization id so each organization keeps its own
  // credential. `cachedTokens` short-circuits secret reads (absence = unloaded,
  // null = loaded-but-absent); `clients` memoizes one LinearClient per org and
  // is invalidated when that org's token rotates.
  private readonly cachedTokens = new Map<string, string | null>();
  private readonly clients = new Map<string, { client: LinearClient; token: string }>();

  private secretKey(organizationId: string): string {
    return orgScopedSecretKey(organizationId, this.LINEAR_TOKEN_SECRET_KEY);
  }

  async saveToken(
    organizationId: string,
    token: string
  ): Promise<{ success: boolean; workspaceName?: string; error?: string }> {
    try {
      const clean = token.trim();
      if (!clean) {
        return { success: false, error: 'Linear token cannot be empty.' };
      }

      const client = this.getClientForToken(organizationId, clean);
      const viewer = await client.viewer;
      const org = await viewer.organization;

      await this.storeToken(organizationId, clean);
      telemetryService.capture('integration_connected', { provider: 'linear' });

      return {
        success: true,
        workspaceName: org?.name ?? viewer.displayName ?? undefined,
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to validate Linear token. Please try again.';
      return { success: false, error: message };
    }
  }

  async clearToken(organizationId: string): Promise<{ success: boolean; error?: string }> {
    try {
      await encryptedAppSecretsStore.deleteSecret(this.secretKey(organizationId));
      this.cachedTokens.set(organizationId, null);
      this.clients.delete(organizationId);
      telemetryService.capture('integration_disconnected', { provider: 'linear' });
      return { success: true };
    } catch (error) {
      log.error('Failed to clear Linear token:', error);
      return {
        success: false,
        error: 'Unable to remove Linear token from secure storage.',
      };
    }
  }

  async checkConnection(organizationId: string): Promise<ConnectionStatus> {
    try {
      const token = await this.getStoredToken(organizationId);
      if (!token) {
        return {
          connected: false,
          capabilities: ISSUE_PROVIDER_CAPABILITIES.linear,
        };
      }

      const client = this.getClientForToken(organizationId, token);
      const viewer = await client.viewer;
      const org = await viewer.organization;

      return {
        connected: true,
        displayName: org?.name ?? viewer.displayName ?? undefined,
        capabilities: ISSUE_PROVIDER_CAPABILITIES.linear,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to verify Linear connection.';
      return {
        connected: false,
        error: message,
        capabilities: ISSUE_PROVIDER_CAPABILITIES.linear,
      };
    }
  }

  async getClient(organizationId: string): Promise<LinearClient | null> {
    const token = await this.getStoredToken(organizationId);
    if (!token) {
      return null;
    }

    return this.getClientForToken(organizationId, token);
  }

  private getClientForToken(organizationId: string, token: string): LinearClient {
    const cached = this.clients.get(organizationId);
    if (cached && cached.token === token) {
      return cached.client;
    }
    const client = new LinearClient({ apiKey: token });
    this.clients.set(organizationId, { client, token });
    return client;
  }

  private async storeToken(organizationId: string, token: string): Promise<void> {
    try {
      await encryptedAppSecretsStore.setSecret(this.secretKey(organizationId), token);
      this.cachedTokens.set(organizationId, token);
    } catch (error) {
      log.error('Failed to store Linear token:', error);
      throw new Error('Unable to store Linear token securely.');
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
      log.error('Failed to read Linear token from secure storage:', error);
      return null;
    }
  }
}

export const linearConnectionService = new LinearConnectionService();
