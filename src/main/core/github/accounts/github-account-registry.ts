import type { GitHubTokenSource } from '@shared/github';
import { normalizeRepositoryHost } from '@shared/repository-ref';

export type GitHubAccountCredentialSource = Exclude<GitHubTokenSource, null>;

export type GitHubProviderAccount = {
  providerId: 'github';
  providerAccountId: string;
  host: string;
  login: string;
  avatarUrl: string;
};

export type GitHubAccount = {
  id: string;
  providerAccountId: string;
  host: string;
  login: string;
  avatarUrl: string;
  credentialSource: GitHubAccountCredentialSource;
  connectedAt: number;
  updatedAt: number;
};

export type GitHubRemovedCliAccount = {
  accountId: string;
  host: string;
  removedAt: number;
};

export type GitHubAccountUpsert = {
  accessToken: string;
  credentialSource: GitHubAccountCredentialSource;
  providerAccount: GitHubProviderAccount;
};

export type GitHubAccountMetadataStore = {
  getAccounts(organizationId: string): Promise<GitHubAccount[] | null>;
  setAccounts(organizationId: string, accounts: GitHubAccount[]): Promise<void>;
  getDefaultAccountId(organizationId: string): Promise<string | null>;
  setDefaultAccountId(organizationId: string, accountId: string | null): Promise<void>;
  getRemovedCliAccounts(organizationId: string): Promise<GitHubRemovedCliAccount[] | null>;
  setRemovedCliAccounts(organizationId: string, accounts: GitHubRemovedCliAccount[]): Promise<void>;
};

export type GitHubAccountSecretStore = {
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
};

export class GitHubAccountRegistry {
  constructor(
    private readonly metadataStore: GitHubAccountMetadataStore,
    private readonly secretStore: GitHubAccountSecretStore
  ) {}

  async upsertAccount(organizationId: string, input: GitHubAccountUpsert): Promise<GitHubAccount> {
    const now = Date.now();
    const id = this.accountId(input.providerAccount);
    const accounts = await this.listAccounts(organizationId);
    const existing = accounts.find((account) => account.id === id);
    const next: GitHubAccount = {
      id,
      providerAccountId: input.providerAccount.providerAccountId,
      host: this.normalizeHost(input.providerAccount.host),
      login: input.providerAccount.login,
      avatarUrl: input.providerAccount.avatarUrl,
      credentialSource: input.credentialSource,
      connectedAt: existing?.connectedAt ?? now,
      updatedAt: now,
    };

    await this.secretStore.setSecret(this.tokenSecretKey(organizationId, id), input.accessToken);
    const nextAccounts = existing
      ? accounts.map((account) => (account.id === id ? next : account))
      : [...accounts, next];
    await this.metadataStore.setAccounts(organizationId, nextAccounts);
    await this.clearRemovedCliAccount(organizationId, id);
    await this.ensureDefaultAccount(organizationId, nextAccounts);
    return next;
  }

  async listAccounts(organizationId: string): Promise<GitHubAccount[]> {
    return (await this.metadataStore.getAccounts(organizationId)) ?? [];
  }

  async getDefaultAccountId(organizationId: string): Promise<string | null> {
    const [accounts, storedDefaultAccountId] = await Promise.all([
      this.listAccounts(organizationId),
      this.metadataStore.getDefaultAccountId(organizationId),
    ]);
    const defaultAccount = storedDefaultAccountId
      ? accounts.find((account) => account.id === storedDefaultAccountId)
      : undefined;
    if (defaultAccount) return defaultAccount.id;

    const fallback = this.oldestAccount(accounts)?.id ?? null;
    if (fallback !== storedDefaultAccountId) {
      await this.metadataStore.setDefaultAccountId(organizationId, fallback);
    }
    return fallback;
  }

  async setDefaultAccountId(
    organizationId: string,
    accountId: string
  ): Promise<GitHubAccount | null> {
    const account = (await this.listAccounts(organizationId)).find(
      (candidate) => candidate.id === accountId
    );
    if (!account) return null;
    await this.metadataStore.setDefaultAccountId(organizationId, account.id);
    return account;
  }

  async resolveToken(organizationId: string, accountId: string): Promise<string | null> {
    return this.secretStore.getSecret(this.tokenSecretKey(organizationId, accountId));
  }

  async listRemovedCliAccounts(organizationId: string): Promise<GitHubRemovedCliAccount[]> {
    return (await this.metadataStore.getRemovedCliAccounts(organizationId)) ?? [];
  }

  async removeAccount(organizationId: string, accountId: string): Promise<void> {
    const accounts = await this.listAccounts(organizationId);
    const removedAccount = accounts.find((account) => account.id === accountId);
    const nextAccounts = accounts.filter((account) => account.id !== accountId);
    await Promise.all([
      this.metadataStore.setAccounts(organizationId, nextAccounts),
      this.secretStore.deleteSecret(this.tokenSecretKey(organizationId, accountId)),
    ]);
    if (removedAccount?.credentialSource === 'cli') {
      await this.addRemovedCliAccount(organizationId, removedAccount);
    }
    const defaultAccountId = await this.metadataStore.getDefaultAccountId(organizationId);
    if (defaultAccountId === accountId) {
      await this.metadataStore.setDefaultAccountId(
        organizationId,
        this.oldestAccount(nextAccounts)?.id ?? null
      );
    }
  }

  private accountId(providerAccount: GitHubProviderAccount): string {
    return `${this.normalizeHost(providerAccount.host)}:${providerAccount.providerAccountId}`;
  }

  private normalizeHost(host: string): string {
    return normalizeRepositoryHost(host) || 'github.com';
  }

  private tokenSecretKey(organizationId: string, accountId: string): string {
    return `github-account-token:${organizationId}:${accountId}`;
  }

  private async ensureDefaultAccount(
    organizationId: string,
    accounts: GitHubAccount[]
  ): Promise<void> {
    const defaultAccountId = await this.metadataStore.getDefaultAccountId(organizationId);
    if (defaultAccountId && accounts.some((account) => account.id === defaultAccountId)) return;
    await this.metadataStore.setDefaultAccountId(
      organizationId,
      this.oldestAccount(accounts)?.id ?? null
    );
  }

  private async addRemovedCliAccount(
    organizationId: string,
    account: GitHubAccount
  ): Promise<void> {
    const tombstone: GitHubRemovedCliAccount = {
      accountId: account.id,
      host: this.normalizeHost(account.host),
      removedAt: Date.now(),
    };
    const tombstones = await this.listRemovedCliAccounts(organizationId);
    await this.metadataStore.setRemovedCliAccounts(organizationId, [
      ...tombstones.filter((candidate) => candidate.accountId !== account.id),
      tombstone,
    ]);
  }

  private async clearRemovedCliAccount(organizationId: string, accountId: string): Promise<void> {
    const tombstones = await this.listRemovedCliAccounts(organizationId);
    if (!tombstones.some((candidate) => candidate.accountId === accountId)) return;
    await this.metadataStore.setRemovedCliAccounts(
      organizationId,
      tombstones.filter((candidate) => candidate.accountId !== accountId)
    );
  }

  private oldestAccount(accounts: GitHubAccount[]): GitHubAccount | undefined {
    return accounts.reduce<GitHubAccount | undefined>((oldest, account) => {
      if (!oldest || account.connectedAt < oldest.connectedAt) return account;
      return oldest;
    }, undefined);
  }
}
