import type { GitHubAccountSummary, GitHubImportCliAccountsResponse } from '@shared/github';
import type {
  GitHubAccount as StoredGitHubAccount,
  GitHubAccountRegistry,
} from './github-account-registry';
import type { GitHubCliAccountImportService } from './github-cli-account-import';

type GitHubAccountStore = Pick<
  GitHubAccountRegistry,
  'getDefaultAccountId' | 'listAccounts' | 'removeAccount' | 'setDefaultAccountId'
>;

type GitHubCliAccountImporter = Pick<GitHubCliAccountImportService, 'importAccounts'>;

export class GitHubAccountService {
  constructor(
    private readonly accountStore: GitHubAccountStore,
    private readonly cliAccountImporter: GitHubCliAccountImporter,
    private readonly clearCachedClients: (
      organizationId: string,
      host?: string,
      accountId?: string
    ) => void = () => {}
  ) {}

  async listAccounts(organizationId: string): Promise<GitHubAccountSummary[]> {
    const [accounts, defaultAccountId] = await Promise.all([
      this.accountStore.listAccounts(organizationId),
      this.accountStore.getDefaultAccountId(organizationId),
    ]);
    return accounts.map((account) => this.toAccountSummary(account, defaultAccountId));
  }

  async importCliAccounts(
    organizationId: string
  ): Promise<Extract<GitHubImportCliAccountsResponse, { success: true }>> {
    const imported = await this.cliAccountImporter.importAccounts(organizationId);
    const importedAccountIds = [...new Set(imported.map((account) => account.id))];
    return {
      success: true,
      accounts: await this.listAccounts(organizationId),
      importedAccountIds,
    };
  }

  async setDefaultAccount(
    organizationId: string,
    accountId: string
  ): Promise<GitHubAccountSummary | null> {
    const account = await this.accountStore.setDefaultAccountId(organizationId, accountId);
    if (!account) return null;
    return this.toAccountSummary(account, account.id);
  }

  async removeAccount(
    organizationId: string,
    accountId: string
  ): Promise<GitHubAccountSummary[] | null> {
    const accounts = await this.accountStore.listAccounts(organizationId);
    const account = accounts.find((candidate) => candidate.id === accountId);
    if (!account) return null;

    await this.accountStore.removeAccount(organizationId, accountId);
    this.clearCachedClients(organizationId, account.host, account.id);
    return this.listAccounts(organizationId);
  }

  private toAccountSummary(
    account: StoredGitHubAccount,
    defaultAccountId: string | null
  ): GitHubAccountSummary {
    return {
      accountId: account.id,
      host: account.host,
      login: account.login,
      avatarUrl: account.avatarUrl,
      credentialSource: account.credentialSource,
      isDefault: account.id === defaultAccountId,
    };
  }
}
