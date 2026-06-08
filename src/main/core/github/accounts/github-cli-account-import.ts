import type { IExecutionContext } from '@main/core/execution-context/types';
import type { GitHubUser } from '@shared/github';
import { normalizeRepositoryHost } from '@shared/repository-ref';
import type { GitHubAccount, GitHubAccountRegistry } from './github-account-registry';

export type GitHubCliAccountImportOptions = {
  skipRemovedAccounts?: boolean;
};

type GitHubIdentityClient = {
  getAuthenticatedUser(token: string, host?: string): Promise<GitHubUser | null>;
};

type GitHubCliAccountEntry = {
  host: string;
  login: string;
  token: string;
};

const GITHUB_CLI_AUTH_STATUS_TIMEOUT_MS = 5_000;

// `gh auth status` has no `--json` mode and GitHub CLI stores tokens in the OS
// keyring (not always in hosts.yml), so scraping `--show-token` text output is the
// supported way to enumerate CLI accounts together with their tokens.
//
// Matches the per-account header for a logged-in account, e.g.
//   ✓ Logged in to github.com account monalisa (keyring)
// Older CLI versions use "as <login>" instead of "account <login>"; both are handled.
// Failed accounts read "Failed to log in to …" and never match this pattern.
const CLI_ACCOUNT_LINE = /Logged in to (\S+) (?:account|as) (\S+)/;
// Matches the token line under an account, e.g. "- Token: gho_xxx" or "✓ Token: gho_xxx".
// The trailing colon prevents it from matching the "- Token scopes: …" line.
const CLI_TOKEN_LINE = /Token:\s+(\S+)/;

function parseCliAccounts(raw: string): GitHubCliAccountEntry[] {
  const accounts: GitHubCliAccountEntry[] = [];
  let pending: { host: string; login: string } | null = null;

  for (const line of raw.split('\n')) {
    const accountMatch = line.match(CLI_ACCOUNT_LINE);
    if (accountMatch) {
      pending = { host: accountMatch[1], login: accountMatch[2] };
      continue;
    }
    if (!pending) continue;
    const tokenMatch = line.match(CLI_TOKEN_LINE);
    if (tokenMatch) {
      accounts.push({ host: pending.host, login: pending.login, token: tokenMatch[1] });
      pending = null;
    }
  }
  return accounts;
}

export class GitHubCliAccountImportService {
  constructor(
    private readonly accountRegistry: GitHubAccountRegistry,
    private readonly ctx: Pick<IExecutionContext, 'exec'>,
    private readonly identityClient: GitHubIdentityClient
  ) {}

  async importAccounts(
    organizationId: string,
    options: GitHubCliAccountImportOptions = {}
  ): Promise<GitHubAccount[]> {
    const raw = await this.readCliStatus();
    if (!raw) return [];

    const removedAccountIds = options.skipRemovedAccounts
      ? new Set(
          (await this.accountRegistry.listRemovedCliAccounts(organizationId)).map(
            (account) => account.accountId
          )
        )
      : new Set<string>();
    const imported: GitHubAccount[] = [];
    for (const entry of parseCliAccounts(raw)) {
      const host = normalizeRepositoryHost(entry.host);
      if (!host) continue;

      const token = entry.token.trim();
      if (token.length === 0) continue;
      const user = await this.identityClient.getAuthenticatedUser(token, host);
      if (!user) continue;
      const accountId = `${host}:${String(user.id)}`;
      if (removedAccountIds.has(accountId)) continue;

      imported.push(
        await this.accountRegistry.upsertAccount(organizationId, {
          accessToken: token,
          credentialSource: 'cli',
          providerAccount: {
            providerId: 'github',
            providerAccountId: String(user.id),
            host,
            login: user.login,
            avatarUrl: user.avatar_url,
          },
        })
      );
    }
    return imported;
  }

  private async readCliStatus(): Promise<string | null> {
    try {
      const { stdout, stderr } = await this.ctx.exec('gh', ['auth', 'status', '--show-token'], {
        timeout: GITHUB_CLI_AUTH_STATUS_TIMEOUT_MS,
      });
      // GitHub CLI 2.x prints to stdout; older versions used stderr. Prefer stdout and
      // fall back to stderr so we work across versions without double-counting accounts.
      const out = stdout.trim().length > 0 ? stdout : stderr;
      return out.trim().length > 0 ? out : null;
    } catch {
      return null;
    }
  }
}
