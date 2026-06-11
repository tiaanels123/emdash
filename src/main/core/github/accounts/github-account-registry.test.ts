import { beforeEach, describe, expect, it } from 'vitest';
import { PERSONAL_ORGANIZATION_ID } from '@shared/organizations';
import {
  GitHubAccountRegistry,
  type GitHubAccount,
  type GitHubAccountMetadataStore,
  type GitHubAccountSecretStore,
  type GitHubRemovedCliAccount,
} from './github-account-registry';

const ORG_ID = PERSONAL_ORGANIZATION_ID;

type OrgMetadata = {
  accounts: GitHubAccount[] | null;
  defaultAccountId: string | null;
  removedCliAccounts: GitHubRemovedCliAccount[] | null;
};

class InMemoryMetadataStore implements GitHubAccountMetadataStore {
  private readonly byOrg = new Map<string, OrgMetadata>();

  private org(organizationId: string): OrgMetadata {
    let metadata = this.byOrg.get(organizationId);
    if (!metadata) {
      metadata = { accounts: null, defaultAccountId: null, removedCliAccounts: null };
      this.byOrg.set(organizationId, metadata);
    }
    return metadata;
  }

  async getAccounts(organizationId: string) {
    return this.org(organizationId).accounts;
  }

  async setAccounts(organizationId: string, accounts: GitHubAccount[]) {
    this.org(organizationId).accounts = accounts;
  }

  async getDefaultAccountId(organizationId: string) {
    return this.org(organizationId).defaultAccountId;
  }

  async setDefaultAccountId(organizationId: string, accountId: string | null) {
    this.org(organizationId).defaultAccountId = accountId;
  }

  async getRemovedCliAccounts(organizationId: string) {
    return this.org(organizationId).removedCliAccounts;
  }

  async setRemovedCliAccounts(organizationId: string, accounts: GitHubRemovedCliAccount[]) {
    this.org(organizationId).removedCliAccounts = accounts;
  }

  // Test-only accessors for asserting/seeding stored default state per org.
  readDefaultAccountId(organizationId: string): string | null {
    return this.org(organizationId).defaultAccountId;
  }

  seedDefaultAccountId(organizationId: string, accountId: string | null): void {
    this.org(organizationId).defaultAccountId = accountId;
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

  // Test-only accessor to assert raw secret keys.
  rawGet(key: string): string | null {
    return this.secrets.get(key) ?? null;
  }
}

describe('GitHubAccountRegistry', () => {
  let metadataStore: InMemoryMetadataStore;
  let secretStore: InMemorySecretStore;
  let registry: GitHubAccountRegistry;

  beforeEach(() => {
    metadataStore = new InMemoryMetadataStore();
    secretStore = new InMemorySecretStore();
    registry = new GitHubAccountRegistry(metadataStore, secretStore);
  });

  async function upsertAccount(login: string, providerAccountId: string, host = 'github.com') {
    return registry.upsertAccount(ORG_ID, {
      accessToken: `gho_${login}`,
      credentialSource: 'emdash_oauth',
      providerAccount: {
        providerId: 'github',
        providerAccountId,
        host,
        login,
        avatarUrl: '',
      },
    });
  }

  it('stores OAuth account metadata separately from the account token', async () => {
    const account = await registry.upsertAccount(ORG_ID, {
      accessToken: 'gho_monalisa',
      credentialSource: 'emdash_oauth',
      providerAccount: {
        providerId: 'github',
        providerAccountId: '42',
        host: 'github.com',
        login: 'monalisa',
        avatarUrl: 'https://avatars.githubusercontent.com/u/42',
      },
    });

    await expect(registry.resolveToken(ORG_ID, account.id)).resolves.toBe('gho_monalisa');
    expect(secretStore.rawGet(`github-account-token:${ORG_ID}:${account.id}`)).toBe('gho_monalisa');
    await expect(registry.listAccounts(ORG_ID)).resolves.toEqual([
      {
        id: 'github.com:42',
        providerAccountId: '42',
        host: 'github.com',
        login: 'monalisa',
        avatarUrl: 'https://avatars.githubusercontent.com/u/42',
        credentialSource: 'emdash_oauth',
        connectedAt: account.connectedAt,
        updatedAt: account.updatedAt,
      },
    ]);
  });

  it('updates an existing account instead of duplicating it', async () => {
    await registry.upsertAccount(ORG_ID, {
      accessToken: 'old-token',
      credentialSource: 'emdash_oauth',
      providerAccount: {
        providerId: 'github',
        providerAccountId: '42',
        host: 'github.com',
        login: 'monalisa',
        avatarUrl: '',
      },
    });

    const updated = await registry.upsertAccount(ORG_ID, {
      accessToken: 'new-token',
      credentialSource: 'emdash_oauth',
      providerAccount: {
        providerId: 'github',
        providerAccountId: '42',
        host: 'github.com',
        login: 'mona',
        avatarUrl: 'https://avatars.githubusercontent.com/u/42',
      },
    });

    await expect(registry.resolveToken(ORG_ID, updated.id)).resolves.toBe('new-token');
    const accounts = await registry.listAccounts(ORG_ID);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      id: 'github.com:42',
      login: 'mona',
      avatarUrl: 'https://avatars.githubusercontent.com/u/42',
    });
  });

  it('removes account metadata and credentials together', async () => {
    const account = await registry.upsertAccount(ORG_ID, {
      accessToken: 'gho_monalisa',
      credentialSource: 'emdash_oauth',
      providerAccount: {
        providerId: 'github',
        providerAccountId: '42',
        host: 'github.com',
        login: 'monalisa',
        avatarUrl: '',
      },
    });

    await registry.removeAccount(ORG_ID, account.id);

    await expect(registry.listAccounts(ORG_ID)).resolves.toEqual([]);
    await expect(registry.resolveToken(ORG_ID, account.id)).resolves.toBeNull();
    expect(secretStore.rawGet(`github-account-token:${ORG_ID}:${account.id}`)).toBeNull();
  });

  it('records a durable tombstone when a CLI-sourced account is removed', async () => {
    const account = await registry.upsertAccount(ORG_ID, {
      accessToken: 'gho_monalisa',
      credentialSource: 'cli',
      providerAccount: {
        providerId: 'github',
        providerAccountId: '42',
        host: 'github.com',
        login: 'monalisa',
        avatarUrl: '',
      },
    });

    await registry.removeAccount(ORG_ID, account.id);

    await expect(registry.listRemovedCliAccounts(ORG_ID)).resolves.toEqual([
      {
        accountId: 'github.com:42',
        host: 'github.com',
        removedAt: expect.any(Number),
      },
    ]);
  });

  it('does not tombstone accounts removed from non-CLI credential sources', async () => {
    const account = await upsertAccount('monalisa', '42');

    await registry.removeAccount(ORG_ID, account.id);

    await expect(registry.listRemovedCliAccounts(ORG_ID)).resolves.toEqual([]);
  });

  it('clears a matching CLI tombstone when the account is reconnected', async () => {
    const account = await registry.upsertAccount(ORG_ID, {
      accessToken: 'gho_monalisa',
      credentialSource: 'cli',
      providerAccount: {
        providerId: 'github',
        providerAccountId: '42',
        host: 'github.com',
        login: 'monalisa',
        avatarUrl: '',
      },
    });
    await registry.removeAccount(ORG_ID, account.id);

    await upsertAccount('monalisa', '42');

    await expect(registry.listRemovedCliAccounts(ORG_ID)).resolves.toEqual([]);
  });

  it('sets the first linked account as the default account', async () => {
    const account = await upsertAccount('monalisa', '42');

    await expect(registry.getDefaultAccountId(ORG_ID)).resolves.toBe(account.id);
  });

  it('does not replace the default account when another account is linked', async () => {
    const first = await upsertAccount('monalisa', '42');
    await upsertAccount('octocat', '84');

    await expect(registry.getDefaultAccountId(ORG_ID)).resolves.toBe(first.id);
  });

  it('allows explicitly changing the default account to a linked account', async () => {
    await upsertAccount('monalisa', '42');
    const second = await upsertAccount('octocat', '84');

    await expect(registry.setDefaultAccountId(ORG_ID, second.id)).resolves.toEqual(second);
    await expect(registry.getDefaultAccountId(ORG_ID)).resolves.toBe(second.id);
  });

  it('does not set the default account to an unknown account id', async () => {
    await upsertAccount('monalisa', '42');

    await expect(registry.setDefaultAccountId(ORG_ID, 'github.com:unknown')).resolves.toBeNull();
    await expect(registry.getDefaultAccountId(ORG_ID)).resolves.toBe('github.com:42');
  });

  it('repairs an invalid stored default account to the oldest linked account', async () => {
    const first = await upsertAccount('monalisa', '42');
    await upsertAccount('octocat', '84');
    metadataStore.seedDefaultAccountId(ORG_ID, 'github.com:missing');

    await expect(registry.getDefaultAccountId(ORG_ID)).resolves.toBe(first.id);
    expect(metadataStore.readDefaultAccountId(ORG_ID)).toBe(first.id);
  });

  it('uses the oldest account as default when a new account is linked and the stored default is invalid', async () => {
    const first = await upsertAccount('monalisa', '42');
    metadataStore.seedDefaultAccountId(ORG_ID, 'github.com:missing');

    await upsertAccount('octocat', '84');

    await expect(registry.getDefaultAccountId(ORG_ID)).resolves.toBe(first.id);
  });

  it('moves the default account to the oldest remaining account when the default is removed', async () => {
    const first = await upsertAccount('monalisa', '42');
    const second = await upsertAccount('octocat', '84');
    const third = await upsertAccount('hubot', '168');
    await registry.setDefaultAccountId(ORG_ID, second.id);

    await registry.removeAccount(ORG_ID, second.id);

    await expect(registry.getDefaultAccountId(ORG_ID)).resolves.toBe(first.id);
    await expect(registry.resolveToken(ORG_ID, second.id)).resolves.toBeNull();
    await expect(registry.resolveToken(ORG_ID, third.id)).resolves.toBe('gho_hubot');
  });

  it('clears the default account when the last account is removed', async () => {
    const account = await upsertAccount('monalisa', '42');

    await registry.removeAccount(ORG_ID, account.id);

    await expect(registry.getDefaultAccountId(ORG_ID)).resolves.toBeNull();
    expect(metadataStore.readDefaultAccountId(ORG_ID)).toBeNull();
  });

  it('stores accounts with the same provider account id on different hosts separately', async () => {
    const githubDotCom = await upsertAccount('monalisa', '42', 'github.com');
    const enterprise = await upsertAccount('enterprise-monalisa', '42', 'ghe.example.com');

    expect(githubDotCom.id).toBe('github.com:42');
    expect(enterprise.id).toBe('ghe.example.com:42');
    await expect(registry.listAccounts(ORG_ID)).resolves.toHaveLength(2);
  });

  it('normalizes www.github.com account hosts to github.com', async () => {
    const account = await upsertAccount('monalisa', '42', 'www.github.com');

    expect(account.id).toBe('github.com:42');
    expect(account.host).toBe('github.com');
  });

  it('isolates accounts, defaults, and tokens between organizations', async () => {
    const otherOrgId = 'org-other';

    const personalAccount = await registry.upsertAccount(ORG_ID, {
      accessToken: 'gho_personal',
      credentialSource: 'emdash_oauth',
      providerAccount: {
        providerId: 'github',
        providerAccountId: '42',
        host: 'github.com',
        login: 'monalisa',
        avatarUrl: '',
      },
    });
    const otherAccount = await registry.upsertAccount(otherOrgId, {
      accessToken: 'gho_other',
      credentialSource: 'emdash_oauth',
      providerAccount: {
        providerId: 'github',
        providerAccountId: '99',
        host: 'github.com',
        login: 'octocat',
        avatarUrl: '',
      },
    });

    // Each org only sees its own account.
    await expect(registry.listAccounts(ORG_ID)).resolves.toEqual([
      expect.objectContaining({ id: personalAccount.id, login: 'monalisa' }),
    ]);
    await expect(registry.listAccounts(otherOrgId)).resolves.toEqual([
      expect.objectContaining({ id: otherAccount.id, login: 'octocat' }),
    ]);

    // Tokens are stored under org-scoped secret keys.
    expect(secretStore.rawGet(`github-account-token:${ORG_ID}:${personalAccount.id}`)).toBe(
      'gho_personal'
    );
    expect(secretStore.rawGet(`github-account-token:${otherOrgId}:${otherAccount.id}`)).toBe(
      'gho_other'
    );
    await expect(registry.resolveToken(ORG_ID, otherAccount.id)).resolves.toBeNull();

    // Defaults are tracked independently per org.
    await expect(registry.getDefaultAccountId(ORG_ID)).resolves.toBe(personalAccount.id);
    await expect(registry.getDefaultAccountId(otherOrgId)).resolves.toBe(otherAccount.id);

    // Removing in one org leaves the other untouched.
    await registry.removeAccount(ORG_ID, personalAccount.id);
    await expect(registry.listAccounts(ORG_ID)).resolves.toEqual([]);
    await expect(registry.listAccounts(otherOrgId)).resolves.toHaveLength(1);
    await expect(registry.resolveToken(otherOrgId, otherAccount.id)).resolves.toBe('gho_other');
  });
});
