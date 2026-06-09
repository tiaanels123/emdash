import { URL } from 'node:url';
import { encryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
import { orgScopedSecretKey } from '@main/core/secrets/org-scoped-secret-key';
import { KV } from '@main/db/kv';
import { telemetryService } from '@main/lib/telemetry';
import { ISSUE_PROVIDER_CAPABILITIES, type ConnectionStatus } from '@shared/issue-providers';
import { doAdoGet } from './azure-devops-http-client';

type AzureDevOpsCreds = { organization: string; project?: string };

interface AzureDevOpsKVSchema extends Record<string, unknown> {
  creds: AzureDevOpsCreds;
}

interface ConnectionData {
  authenticatedUser?: { providerDisplayName?: string };
}

/**
 * Resolves the API base URL for an Azure DevOps organization. Accepts either a
 * bare organization name (cloud, e.g. "qala" → https://dev.azure.com/qala) or a
 * full base URL (on-prem Azure DevOps Server / Services collection), used verbatim.
 */
export function resolveAzureDevOpsBaseUrl(organization: string): string {
  const trimmed = organization.trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://dev.azure.com/${encodeURIComponent(trimmed)}`;
}

export class AzureDevOpsConnectionService {
  private readonly TOKEN_SECRET_KEY = 'emdash-azure-devops-token';

  // Connection metadata (organization, optional project) lives in a per-organization
  // KV namespace; the PAT is stored under an org-scoped key in the encrypted app
  // secrets store. KV instances are memoized per organization id.
  private readonly kvByOrg = new Map<string, KV<AzureDevOpsKVSchema>>();

  private secretKey(organizationId: string): string {
    return orgScopedSecretKey(organizationId, this.TOKEN_SECRET_KEY);
  }

  private kv(organizationId: string): KV<AzureDevOpsKVSchema> {
    const cached = this.kvByOrg.get(organizationId);
    if (cached) {
      return cached;
    }
    const kv = new KV<AzureDevOpsKVSchema>(`azuredevops:${organizationId}`);
    this.kvByOrg.set(organizationId, kv);
    return kv;
  }

  async saveCredentials(
    organizationId: string,
    organization: string,
    pat: string,
    project?: string
  ): Promise<{ success: boolean; displayName?: string; error?: string }> {
    try {
      const displayName = await this.verify(organization, pat);
      await encryptedAppSecretsStore.setSecret(this.secretKey(organizationId), pat);
      await this.writeCreds(organizationId, { organization, project });
      telemetryService.capture('integration_connected', { provider: 'azuredevops' });
      return { success: true, displayName };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async clearCredentials(organizationId: string): Promise<{ success: boolean; error?: string }> {
    try {
      try {
        await encryptedAppSecretsStore.deleteSecret(this.secretKey(organizationId));
      } catch {}
      try {
        await this.kv(organizationId).del('creds');
      } catch {}
      telemetryService.capture('integration_disconnected', { provider: 'azuredevops' });
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async checkConnection(organizationId: string): Promise<ConnectionStatus> {
    try {
      const creds = await this.readCreds(organizationId);
      if (!creds) {
        return { connected: false, capabilities: ISSUE_PROVIDER_CAPABILITIES.azuredevops };
      }

      const pat = await encryptedAppSecretsStore.getSecret(this.secretKey(organizationId));
      if (!pat) {
        return { connected: false, capabilities: ISSUE_PROVIDER_CAPABILITIES.azuredevops };
      }

      const displayName = await this.verify(creds.organization, pat);
      return {
        connected: true,
        displayName,
        capabilities: ISSUE_PROVIDER_CAPABILITIES.azuredevops,
      };
    } catch (error) {
      return {
        connected: false,
        error: error instanceof Error ? error.message : String(error),
        capabilities: ISSUE_PROVIDER_CAPABILITIES.azuredevops,
      };
    }
  }

  async requireAuth(
    organizationId: string
  ): Promise<{ baseUrl: string; organization: string; project?: string; pat: string }> {
    const creds = await this.readCreds(organizationId);
    if (!creds) throw new Error('Azure DevOps credentials not set.');

    const pat = await encryptedAppSecretsStore.getSecret(this.secretKey(organizationId));
    if (!pat) throw new Error('Azure DevOps token not found.');

    return {
      baseUrl: resolveAzureDevOpsBaseUrl(creds.organization),
      organization: creds.organization,
      project: creds.project,
      pat,
    };
  }

  private async readCreds(organizationId: string): Promise<AzureDevOpsCreds | null> {
    try {
      const obj = await this.kv(organizationId).get('creds');
      const organization = String(obj?.organization || '').trim();
      if (!organization) return null;
      const project = String(obj?.project || '').trim();
      return { organization, project: project || undefined };
    } catch {
      return null;
    }
  }

  private async writeCreds(organizationId: string, creds: AzureDevOpsCreds): Promise<void> {
    await this.kv(organizationId).set('creds', {
      organization: creds.organization,
      project: creds.project,
    });
  }

  private async verify(organization: string, pat: string): Promise<string | undefined> {
    const base = resolveAzureDevOpsBaseUrl(organization);
    // connectionData is a preview resource — plain "7.1" is rejected with HTTP 400.
    const url = new URL(`${base}/_apis/connectionData?api-version=7.1-preview`);
    const body = await doAdoGet(url, pat);
    const data = JSON.parse(body || '{}') as ConnectionData;
    // A valid PAT returns an authenticated user; an invalid one yields a sign-in page
    // (non-JSON, so JSON.parse above throws) or a payload without authenticatedUser.
    if (!data?.authenticatedUser) {
      throw new Error('Failed to verify Azure DevOps token.');
    }
    return data.authenticatedUser.providerDisplayName;
  }
}

export const azureDevOpsConnectionService = new AzureDevOpsConnectionService();
