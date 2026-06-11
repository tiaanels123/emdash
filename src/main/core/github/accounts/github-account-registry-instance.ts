import { encryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
import { KV } from '@main/db/kv';
import {
  GitHubAccountRegistry,
  type GitHubAccount,
  type GitHubRemovedCliAccount,
} from './github-account-registry';

type GitHubAccountsKVSchema = {
  accounts: GitHubAccount[];
  defaultAccountId: string | null;
  removedCliAccounts: GitHubRemovedCliAccount[];
};

// Account metadata is partitioned per organization: each org gets its own KV
// namespace (`githubAccounts:<orgId>`), so connecting an account in one
// organization never surfaces it in another. KV instances are memoized per org.
const kvByOrg = new Map<string, KV<GitHubAccountsKVSchema>>();

function githubAccountsKV(organizationId: string): KV<GitHubAccountsKVSchema> {
  let kv = kvByOrg.get(organizationId);
  if (!kv) {
    kv = new KV<GitHubAccountsKVSchema>(`githubAccounts:${organizationId}`);
    kvByOrg.set(organizationId, kv);
  }
  return kv;
}

const metadataStore = {
  getAccounts(organizationId: string): Promise<GitHubAccount[] | null> {
    return githubAccountsKV(organizationId).get('accounts');
  },
  setAccounts(organizationId: string, accounts: GitHubAccount[]): Promise<void> {
    return githubAccountsKV(organizationId).setOrThrow('accounts', accounts);
  },
  getDefaultAccountId(organizationId: string): Promise<string | null> {
    return githubAccountsKV(organizationId).get('defaultAccountId');
  },
  setDefaultAccountId(organizationId: string, accountId: string | null): Promise<void> {
    return githubAccountsKV(organizationId).setOrThrow('defaultAccountId', accountId);
  },
  getRemovedCliAccounts(organizationId: string): Promise<GitHubRemovedCliAccount[] | null> {
    return githubAccountsKV(organizationId).get('removedCliAccounts');
  },
  setRemovedCliAccounts(
    organizationId: string,
    accounts: GitHubRemovedCliAccount[]
  ): Promise<void> {
    return githubAccountsKV(organizationId).setOrThrow('removedCliAccounts', accounts);
  },
};

export const githubAccountRegistry = new GitHubAccountRegistry(
  metadataStore,
  encryptedAppSecretsStore
);
