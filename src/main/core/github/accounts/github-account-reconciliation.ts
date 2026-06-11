import { PERSONAL_ORGANIZATION_ID } from '@shared/organizations';
import type { GitHubAccount } from './github-account-registry';

type LegacyAccountBackfill = {
  backfillLegacyToken(organizationId: string): Promise<GitHubAccount | null>;
};

type CliAccountImporter = {
  importAccounts(
    organizationId: string,
    options?: { skipRemovedAccounts?: boolean }
  ): Promise<GitHubAccount[]>;
};

type WarningLogger = {
  warn(message: string, context: Record<string, unknown>): void;
};

export type GitHubAccountReconciliationResult = {
  legacyAccountId: string | null;
  importedCliAccountIds: string[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class GitHubAccountReconciliationService {
  constructor(
    private readonly deps: {
      legacyBackfill: LegacyAccountBackfill;
      cliImporter: CliAccountImporter;
      logger: WarningLogger;
    }
  ) {}

  /**
   * Startup reconciliation runs before any organization is "active" (and would
   * race across windows if it tried to pick one), so legacy and CLI accounts
   * discovered at boot are filed under the Personal organization — the same
   * destination the one-time data migration used for pre-existing accounts.
   */
  async reconcileAtStartup(): Promise<GitHubAccountReconciliationResult> {
    const organizationId = PERSONAL_ORGANIZATION_ID;
    const legacyAccount = await this.backfillLegacyToken(organizationId);
    const cliAccounts = await this.importCliAccounts(organizationId);

    return {
      legacyAccountId: legacyAccount?.id ?? null,
      importedCliAccountIds: [...new Set(cliAccounts.map((account) => account.id))],
    };
  }

  private async backfillLegacyToken(organizationId: string): Promise<GitHubAccount | null> {
    try {
      return await this.deps.legacyBackfill.backfillLegacyToken(organizationId);
    } catch (error) {
      this.deps.logger.warn('Failed to backfill legacy GitHub account token', {
        error: errorMessage(error),
      });
      return null;
    }
  }

  private async importCliAccounts(organizationId: string): Promise<GitHubAccount[]> {
    try {
      return await this.deps.cliImporter.importAccounts(organizationId, {
        skipRemovedAccounts: true,
      });
    } catch (error) {
      this.deps.logger.warn('Failed to import GitHub CLI accounts during startup', {
        error: errorMessage(error),
      });
      return [];
    }
  }
}
