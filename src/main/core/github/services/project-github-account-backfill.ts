import type { ProjectSettings } from '@shared/core/project-settings/project-settings';
import type { Result } from '@shared/lib/result';
import { normalizeRepositoryHost, parseRepositoryRef } from '@shared/repository-ref';
import type { GitHubAccount, GitHubAccountRegistry } from '../accounts/github-account-registry';

type AccountLookup = Pick<GitHubAccountRegistry, 'getDefaultAccountId' | 'listAccounts'>;

type ProjectSettingsForBackfill = {
  get(): Promise<ProjectSettings>;
  patch(patch: { githubAccountId?: string | null }): Promise<Result<void, unknown>>;
};

type ProjectRemote = { name: string; url: string };

type ProjectForGitHubAccountBackfill = {
  projectId: string;
  settings: ProjectSettingsForBackfill;
  getRemotes(): Promise<ProjectRemote[]>;
};

export type ProjectGitHubAccountBackfillResult =
  | { status: 'updated'; accountId: string }
  | { status: 'skipped' };

/**
 * Order remotes so `origin` is considered first, then preserve the original order.
 * `origin` is the canonical remote, so a matching account there should win.
 */
function originFirst(remotes: ProjectRemote[]): ProjectRemote[] {
  return [...remotes].sort((a, b) => {
    if (a.name === b.name) return 0;
    if (a.name === 'origin') return -1;
    if (b.name === 'origin') return 1;
    return 0;
  });
}

export class ProjectGitHubAccountBackfillService {
  constructor(
    private readonly accountLookup: AccountLookup,
    private readonly getOrganizationId: (projectId: string) => Promise<string>
  ) {}

  async backfillProject(
    project: ProjectForGitHubAccountBackfill
  ): Promise<ProjectGitHubAccountBackfillResult> {
    const settings = await project.settings.get();
    if (Object.hasOwn(settings, 'githubAccountId')) return { status: 'skipped' };

    const remotes = await project.getRemotes();
    if (remotes.length === 0) return { status: 'skipped' };

    const organizationId = await this.getOrganizationId(project.projectId);
    // Consider every remote (preferring `origin`), not just the configured base remote.
    // This keeps backfill working when a project's base remote is misconfigured and
    // mirrors how PR sync enumerates a project's GitHub remotes from the remote list.
    for (const remote of originFirst(remotes)) {
      const repository = parseRepositoryRef(remote.url);
      if (!repository) continue;

      const accountId = await this.selectAccountIdForHost(organizationId, repository.host);
      if (!accountId) continue;

      const result = await project.settings.patch({ githubAccountId: accountId });
      return result.success ? { status: 'updated', accountId } : { status: 'skipped' };
    }
    return { status: 'skipped' };
  }

  private async selectAccountIdForHost(
    organizationId: string,
    host: string
  ): Promise<string | null> {
    const normalizedHost = normalizeRepositoryHost(host);
    const [accounts, defaultAccountId] = await Promise.all([
      this.accountLookup.listAccounts(organizationId),
      this.accountLookup.getDefaultAccountId(organizationId),
    ]);
    const hostAccounts = accounts.filter(
      (account) => normalizeRepositoryHost(account.host) === normalizedHost
    );
    if (hostAccounts.length === 0) return null;

    const defaultAccount = hostAccounts.find((account) => account.id === defaultAccountId);
    return defaultAccount?.id ?? this.oldestAccount(hostAccounts)?.id ?? null;
  }

  private oldestAccount(accounts: GitHubAccount[]): GitHubAccount | undefined {
    return accounts.reduce<GitHubAccount | undefined>((oldest, account) => {
      if (!oldest || account.connectedAt < oldest.connectedAt) return account;
      return oldest;
    }, undefined);
  }
}
