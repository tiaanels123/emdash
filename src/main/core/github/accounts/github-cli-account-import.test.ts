import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IExecutionContext } from '@main/core/execution-context/types';
import type { GitHubUser } from '@shared/github';
import { PERSONAL_ORGANIZATION_ID } from '@shared/organizations';
import {
  GitHubAccountRegistry,
  type GitHubAccount,
  type GitHubAccountMetadataStore,
  type GitHubAccountSecretStore,
  type GitHubRemovedCliAccount,
} from './github-account-registry';
import { GitHubCliAccountImportService } from './github-cli-account-import';

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

function makeGitHubUser(id: number, login: string): GitHubUser {
  return {
    id,
    login,
    name: login,
    email: '',
    avatar_url: `https://avatars.githubusercontent.com/u/${id}`,
  };
}

function makeCtx(stdout: string): Pick<IExecutionContext, 'exec'> {
  return {
    exec: vi.fn().mockResolvedValue({ stdout, stderr: '' }),
  };
}

describe('GitHubCliAccountImportService', () => {
  let registry: GitHubAccountRegistry;
  let usersByToken: Map<string, GitHubUser>;
  let getAuthenticatedUser: ReturnType<
    typeof vi.fn<(token: string, host?: string) => Promise<GitHubUser | null>>
  >;

  beforeEach(() => {
    registry = new GitHubAccountRegistry(new InMemoryMetadataStore(), new InMemorySecretStore());
    usersByToken = new Map([
      ['gho_monalisa', makeGitHubUser(42, 'monalisa')],
      ['gho_octocat', makeGitHubUser(84, 'octocat')],
      ['ghes_enterprise', makeGitHubUser(168, 'enterprise')],
    ]);
    getAuthenticatedUser = vi.fn<(token: string, host?: string) => Promise<GitHubUser | null>>(
      async (token: string) => usersByToken.get(token) ?? null
    );
  });

  function makeService(stdout: string) {
    return new GitHubCliAccountImportService(registry, makeCtx(stdout), { getAuthenticatedUser });
  }

  it('imports every GitHub.com account reported by GitHub CLI as linked accounts', async () => {
    const service = makeService(
      JSON.stringify({
        hosts: {
          'github.com': [
            {
              state: 'success',
              active: true,
              host: 'github.com',
              login: 'monalisa',
              token: 'gho_monalisa',
            },
            {
              state: 'success',
              active: false,
              host: 'github.com',
              login: 'octocat',
              token: 'gho_octocat',
            },
          ],
        },
      })
    );

    const imported = await service.importAccounts(ORG_ID);

    expect(imported.map((account) => account.id)).toEqual(['github.com:42', 'github.com:84']);
    await expect(registry.resolveToken(ORG_ID, 'github.com:42')).resolves.toBe('gho_monalisa');
    await expect(registry.resolveToken(ORG_ID, 'github.com:84')).resolves.toBe('gho_octocat');
    await expect(registry.getDefaultAccountId(ORG_ID)).resolves.toBe('github.com:42');
  });

  it('bounds the GitHub CLI status call so startup cannot hang indefinitely', async () => {
    const ctx = makeCtx(JSON.stringify({ hosts: {} }));
    const service = new GitHubCliAccountImportService(registry, ctx, { getAuthenticatedUser });

    await service.importAccounts(ORG_ID);

    expect(ctx.exec).toHaveBeenCalledWith(
      'gh',
      ['auth', 'status', '--json', 'hosts', '--show-token'],
      { timeout: 5_000 }
    );
  });

  it('keeps existing linked accounts that are no longer reported by GitHub CLI', async () => {
    await registry.upsertAccount(ORG_ID, {
      accessToken: 'gho_existing',
      credentialSource: 'cli',
      providerAccount: {
        providerId: 'github',
        providerAccountId: '168',
        host: 'github.com',
        login: 'hubot',
        avatarUrl: '',
      },
    });

    const service = makeService(
      JSON.stringify({
        hosts: {
          'github.com': [
            {
              state: 'success',
              active: true,
              host: 'github.com',
              login: 'monalisa',
              token: 'gho_monalisa',
            },
          ],
        },
      })
    );

    await service.importAccounts(ORG_ID);

    await expect(registry.listAccounts(ORG_ID)).resolves.toHaveLength(2);
    await expect(registry.resolveToken(ORG_ID, 'github.com:168')).resolves.toBe('gho_existing');
  });

  it('ignores CLI entries that cannot be resolved to a GitHub user', async () => {
    usersByToken.delete('gho_octocat');
    const service = makeService(
      JSON.stringify({
        hosts: {
          'github.com': [
            {
              state: 'success',
              active: true,
              host: 'github.com',
              login: 'monalisa',
              token: 'gho_monalisa',
            },
            {
              state: 'success',
              active: false,
              host: 'github.com',
              login: 'octocat',
              token: 'gho_octocat',
            },
          ],
        },
      })
    );

    const imported = await service.importAccounts(ORG_ID);

    expect(imported.map((account) => account.id)).toEqual(['github.com:42']);
    await expect(registry.listAccounts(ORG_ID)).resolves.toHaveLength(1);
  });

  it('imports GitHub Enterprise accounts reported by GitHub CLI', async () => {
    const service = makeService(
      JSON.stringify({
        hosts: {
          'ghe.example.com': [
            {
              state: 'success',
              active: true,
              host: 'ghe.example.com',
              login: 'enterprise',
              token: 'ghes_enterprise',
            },
          ],
        },
      })
    );

    const imported = await service.importAccounts(ORG_ID);

    expect(imported.map((account) => account.id)).toEqual(['ghe.example.com:168']);
    expect(getAuthenticatedUser).toHaveBeenCalledWith('ghes_enterprise', 'ghe.example.com');
    await expect(registry.resolveToken(ORG_ID, 'ghe.example.com:168')).resolves.toBe(
      'ghes_enterprise'
    );
  });

  it('uses the CLI hosts map key as the authoritative account host', async () => {
    const service = makeService(
      JSON.stringify({
        hosts: {
          'ghe.example.com': [
            {
              state: 'success',
              active: true,
              host: 'github.com',
              login: 'enterprise',
              token: 'ghes_enterprise',
            },
          ],
        },
      })
    );

    const imported = await service.importAccounts(ORG_ID);

    expect(imported.map((account) => account.id)).toEqual(['ghe.example.com:168']);
    expect(getAuthenticatedUser).toHaveBeenCalledWith('ghes_enterprise', 'ghe.example.com');
  });

  it('skips tombstoned CLI accounts during startup import', async () => {
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
    const service = makeService(
      JSON.stringify({
        hosts: {
          'github.com': [
            {
              state: 'success',
              active: true,
              host: 'github.com',
              login: 'monalisa',
              token: 'gho_monalisa',
            },
          ],
        },
      })
    );

    await expect(service.importAccounts(ORG_ID, { skipRemovedAccounts: true })).resolves.toEqual(
      []
    );
    await expect(registry.listAccounts(ORG_ID)).resolves.toEqual([]);
    await expect(registry.listRemovedCliAccounts(ORG_ID)).resolves.toHaveLength(1);
  });

  it('explicit imports reconnect tombstoned CLI accounts and clear the tombstone', async () => {
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
    const service = makeService(
      JSON.stringify({
        hosts: {
          'github.com': [
            {
              state: 'success',
              active: true,
              host: 'github.com',
              login: 'monalisa',
              token: 'gho_monalisa',
            },
          ],
        },
      })
    );

    await expect(service.importAccounts(ORG_ID)).resolves.toMatchObject([
      { id: 'github.com:42', credentialSource: 'cli' },
    ]);
    await expect(registry.listRemovedCliAccounts(ORG_ID)).resolves.toEqual([]);
  });
});
