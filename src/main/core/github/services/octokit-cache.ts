import type { Octokit } from '@octokit/rest';
import { normalizeRepositoryHost } from '@shared/repository-ref';
import type { GitHubApiAuthContext } from './github-api-auth-service';

const cachedOctokits = new Map<string, { octokit: Octokit; token: string }>();

function cacheKeyFor(host: string, context: GitHubApiAuthContext): string {
  const accountId = context.accountId?.trim() || 'default';
  return `${context.organizationId}:${host}:${accountId}`;
}

export function getCachedOctokit(host: string, context: GitHubApiAuthContext) {
  return cachedOctokits.get(cacheKeyFor(host, context));
}

export function setCachedOctokit(
  host: string,
  context: GitHubApiAuthContext,
  value: { octokit: Octokit; token: string }
): void {
  cachedOctokits.set(cacheKeyFor(host, context), value);
}

/**
 * Clears cached Octokit clients for an organization. When `host`/`accountId`
 * are provided the deletion is narrowed to that org's matching entries;
 * otherwise every cached client for the organization is removed.
 */
export function clearOctokitCache(
  organizationId: string,
  host?: string,
  accountId?: string
): void {
  if (host) {
    const normalizedHost = normalizeRepositoryHost(host);
    if (accountId) {
      cachedOctokits.delete(cacheKeyFor(normalizedHost, { organizationId, accountId }));
      return;
    }
    for (const key of cachedOctokits.keys()) {
      if (key.startsWith(`${organizationId}:${normalizedHost}:`)) cachedOctokits.delete(key);
    }
    return;
  }
  for (const key of cachedOctokits.keys()) {
    if (key.startsWith(`${organizationId}:`)) cachedOctokits.delete(key);
  }
}
