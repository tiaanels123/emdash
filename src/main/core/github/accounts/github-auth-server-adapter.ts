import type { ProviderTokenPayload } from '@main/core/account/provider-token-registry';
import { PERSONAL_ORGANIZATION_ID } from '@shared/organizations';
import type { GitHubAccountRegistry } from './github-account-registry';

export class GitHubAuthServerAdapter {
  constructor(private readonly accountRegistry: GitHubAccountRegistry) {}

  async storeOAuthToken(payload: ProviderTokenPayload): Promise<void> {
    if (!payload.providerAccount) {
      return;
    }

    if (payload.providerAccount.providerId !== 'github') {
      return;
    }

    // The generic OAuth provider-token flow does not carry an organization, so
    // OAuth-linked GitHub accounts are filed under the Personal organization.
    // The org-aware GitHub connect paths (device flow + CLI import) thread the
    // active organization explicitly via the github controller.
    const organizationId = payload.organizationId ?? PERSONAL_ORGANIZATION_ID;

    await this.accountRegistry.upsertAccount(organizationId, {
      accessToken: payload.accessToken,
      credentialSource: 'emdash_oauth',
      providerAccount: {
        providerId: 'github',
        providerAccountId: payload.providerAccount.providerAccountId,
        host: payload.providerAccount.host,
        login: payload.providerAccount.login,
        avatarUrl: payload.providerAccount.avatarUrl,
      },
    });
  }
}
