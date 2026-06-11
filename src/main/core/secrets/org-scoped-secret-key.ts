/**
 * Derives an organization-scoped secret key from a base integration key.
 *
 * Integration credentials are stored in the flat `app_secrets` key/value table
 * (see {@link ./encrypted-app-secrets-store}). To isolate credentials per
 * organization we namespace the key with the organization id, e.g. Linear's
 * `'emdash-linear-token'` becomes `'emdash-linear-token:<organizationId>'`.
 *
 * The base key is kept as the prefix (org id appended) so the legacy/global key
 * remains a recognizable prefix for migration scans. This mirrors the existing
 * `${base}:${id}` precedents (`github-account-token:<accountId>`,
 * `ssh:<connectionId>:password`).
 */
export function orgScopedSecretKey(organizationId: string, baseKey: string): string {
  return `${baseKey}:${organizationId}`;
}
