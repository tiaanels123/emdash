import { beforeEach, describe, expect, it } from 'vitest';
import type { ProviderTokenPayload } from '@main/core/account/provider-token-registry';
import { PERSONAL_ORGANIZATION_ID } from '@shared/organizations';
import {
  GitHubAccountRegistry,
  type GitHubAccount,
  type GitHubAccountMetadataStore,
  type GitHubAccountSecretStore,
  type GitHubRemovedCliAccount,
} from './github-account-registry';
import { GitHubAuthServerAdapter } from './github-auth-server-adapter';

// The OAuth adapter does not carry an organization, so it files accounts under
// the Personal organization. Reads in these tests use the same org id.
const ORG_ID = PERSONAL_ORGANIZATION_ID;

class InMemoryMetadataStore implements GitHubAccountMetadataStore {
  private readonly accountsByOrg = new Map<string, GitHubAccount[]>();
  private readonly defaultAccountIdByOrg = new Map<string, string | null>();
  private readonly removedCliAccountsByOrg = new Map<string, GitHubRemovedCliAccount[]>();

  async getAccounts(organizationId: string) {
    return this.accountsByOrg.get(organizationId) ?? null;
  }

  async setAccounts(organizationId: string, accounts: GitHubAccount[]) {
    this.accountsByOrg.set(organizationId, accounts);
  }

  async getDefaultAccountId(organizationId: string) {
    return this.defaultAccountIdByOrg.get(organizationId) ?? null;
  }

  async setDefaultAccountId(organizationId: string, accountId: string | null) {
    this.defaultAccountIdByOrg.set(organizationId, accountId);
  }

  async getRemovedCliAccounts(organizationId: string) {
    return this.removedCliAccountsByOrg.get(organizationId) ?? null;
  }

  async setRemovedCliAccounts(organizationId: string, accounts: GitHubRemovedCliAccount[]) {
    this.removedCliAccountsByOrg.set(organizationId, accounts);
  }
}

class InMemorySecretStore implements GitHubAccountSecretStore {
  private readonly secrets = new Map<string, string>();

  async getSecret(key: string) {
    return this.secrets.get(key) ?? null;
  }

  async setSecret(key: string, value: string) {
    this.secrets.set(key, value);
  }

  async deleteSecret(key: string) {
    this.secrets.delete(key);
  }
}

describe('GitHubAuthServerAdapter', () => {
  let registry: GitHubAccountRegistry;
  let adapter: GitHubAuthServerAdapter;

  beforeEach(() => {
    registry = new GitHubAccountRegistry(new InMemoryMetadataStore(), new InMemorySecretStore());
    adapter = new GitHubAuthServerAdapter(registry);
  });

  it('stores auth-server tokens with provider account metadata in the account registry only', async () => {
    const payload: ProviderTokenPayload = {
      accessToken: 'gho_monalisa',
      providerAccount: {
        providerId: 'github',
        providerAccountId: '42',
        host: 'github.com',
        login: 'monalisa',
        avatarUrl: 'https://avatars.githubusercontent.com/u/42',
      },
    };

    await adapter.storeOAuthToken(payload);

    const accounts = await registry.listAccounts(ORG_ID);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      id: 'github.com:42',
      login: 'monalisa',
      credentialSource: 'emdash_oauth',
    });
    await expect(registry.resolveToken(ORG_ID, 'github.com:42')).resolves.toBe('gho_monalisa');
  });

  it('stores linked provider accounts in the account registry', async () => {
    const payload: ProviderTokenPayload = {
      accessToken: 'gho_octocat',
      providerAccount: {
        providerId: 'github',
        providerAccountId: '84',
        host: 'github.com',
        login: 'octocat',
        avatarUrl: 'https://avatars.githubusercontent.com/u/84',
      },
    };

    await adapter.storeOAuthToken(payload);

    const accounts = await registry.listAccounts(ORG_ID);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      id: 'github.com:84',
      login: 'octocat',
      credentialSource: 'emdash_oauth',
    });
    await expect(registry.resolveToken(ORG_ID, 'github.com:84')).resolves.toBe('gho_octocat');
  });

  it('does not store tokens when auth-server metadata is absent', async () => {
    await adapter.storeOAuthToken({ accessToken: 'gho_legacy' });

    await expect(registry.listAccounts(ORG_ID)).resolves.toEqual([]);
  });
});
