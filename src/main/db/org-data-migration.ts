import type BetterSqlite3 from 'better-sqlite3';
import { orgScopedSecretKey } from '@main/core/secrets/org-scoped-secret-key';
import { PERSONAL_ORGANIZATION_ID, PERSONAL_ORGANIZATION_NAME } from '@shared/organizations';

/**
 * One-time, idempotent data migration that introduces the default "Personal"
 * organization and reparents all existing data under it. Runs on every boot
 * after the schema migrations, but no-ops once the version key is recorded.
 *
 * Operates on a raw SQLite connection (no Electron / Drizzle) so it can run in
 * the migration runner and be exercised by migration tests. Integration secrets
 * are re-keyed by COPYING the already-encrypted ciphertext to the new key (no
 * decrypt/re-encrypt), which avoids needing `safeStorage` availability at boot
 * and keeps the operation a pure SQL row copy.
 */
const ORG_MIGRATION_KV_KEY = 'organization_migration_version';
const ORG_MIGRATION_VERSION = '1';

/**
 * Legacy global secret keys for the single-credential integrations. Each is
 * copied to its Personal-org-scoped key. The account session token
 * (`emdash-account-token`) and the legacy GitHub token (`emdash-github-token`)
 * are intentionally NOT here — they stay global (see the legacy-port reset
 * PRESERVED_SECRET_KEYS).
 */
const LEGACY_GLOBAL_SECRET_KEYS = [
  'emdash-linear-token',
  'emdash-jira-token',
  'emdash-asana-token',
  'emdash-plain-token',
  'emdash-featurebase-token',
  'emdash-monday-credentials',
  'emdash-trello-credentials',
  'emdash-gitlab-token',
  'emdash-forgejo-token',
] as const;

const GITHUB_TOKEN_KEY_PREFIX = 'github-account-token:';
const GITHUB_ACCOUNTS_KV_PREFIX = 'githubAccounts:';

export function ensureDefaultOrganization(connection: BetterSqlite3.Database): void {
  // The data migration is a no-op until the schema migration that creates the
  // `organizations` table has run. This keeps boot order robust (and lets
  // fixtures be generated at an earlier migration boundary).
  const hasOrganizationsTable = connection
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'organizations'`)
    .get();
  if (!hasOrganizationsTable) return;

  const versionRow = connection
    .prepare(`SELECT value FROM kv WHERE key = ?`)
    .get(ORG_MIGRATION_KV_KEY) as { value: string } | undefined;
  if (versionRow?.value === ORG_MIGRATION_VERSION) return;

  const orgPrefix = `${PERSONAL_ORGANIZATION_ID}:`;

  connection.transaction(() => {
    // 1. Create the default Personal organization.
    connection
      .prepare(
        `INSERT OR IGNORE INTO organizations (id, name, color, icon, sort_order, created_at, updated_at)
         VALUES (?, ?, NULL, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      )
      .run(PERSONAL_ORGANIZATION_ID, PERSONAL_ORGANIZATION_NAME);

    // 2. Reparent existing projects. The schema migration already backfills the
    //    column default, so this only catches stragglers, but is cheap and safe.
    connection
      .prepare(
        `UPDATE projects SET organization_id = ? WHERE organization_id IS NULL OR organization_id = ''`
      )
      .run(PERSONAL_ORGANIZATION_ID);

    // 3. Re-key single-credential integration secrets (copy ciphertext, keep old global key).
    const copySecret = connection.prepare(
      `INSERT OR IGNORE INTO app_secrets (key, secret) SELECT ?, secret FROM app_secrets WHERE key = ?`
    );
    for (const baseKey of LEGACY_GLOBAL_SECRET_KEYS) {
      copySecret.run(orgScopedSecretKey(PERSONAL_ORGANIZATION_ID, baseKey), baseKey);
    }

    // 3b. GitHub per-account tokens: github-account-token:<accountId>
    //     -> github-account-token:<orgId>:<accountId>
    const insertSecret = connection.prepare(
      `INSERT OR IGNORE INTO app_secrets (key, secret) VALUES (?, ?)`
    );
    const ghTokenRows = connection
      .prepare(`SELECT key, secret FROM app_secrets WHERE key LIKE ?`)
      .all(`${GITHUB_TOKEN_KEY_PREFIX}%`) as Array<{ key: string; secret: string }>;
    for (const row of ghTokenRows) {
      const accountId = row.key.slice(GITHUB_TOKEN_KEY_PREFIX.length);
      if (accountId.startsWith(orgPrefix)) continue; // already org-scoped (idempotency guard)
      insertSecret.run(
        `${GITHUB_TOKEN_KEY_PREFIX}${PERSONAL_ORGANIZATION_ID}:${accountId}`,
        row.secret
      );
    }

    // 4. Re-key non-secret KV connection config into the Personal org (copy, keep old).
    rekeyKv(connection, 'jira:creds', `jira:${PERSONAL_ORGANIZATION_ID}:creds`);
    rekeyKv(connection, 'gitlab:connection', `gitlab:${PERSONAL_ORGANIZATION_ID}:connection`);
    rekeyKv(connection, 'forgejo:connection', `forgejo:${PERSONAL_ORGANIZATION_ID}:connection`);

    // 4b. GitHub account metadata KV: githubAccounts:<k> -> githubAccounts:<orgId>:<k>
    const insertKv = connection.prepare(
      `INSERT OR IGNORE INTO kv (key, value, updated_at) VALUES (?, ?, ?)`
    );
    const ghKvRows = connection
      .prepare(`SELECT key, value, updated_at FROM kv WHERE key LIKE ?`)
      .all(`${GITHUB_ACCOUNTS_KV_PREFIX}%`) as Array<{
      key: string;
      value: string;
      updated_at: number;
    }>;
    for (const row of ghKvRows) {
      const sub = row.key.slice(GITHUB_ACCOUNTS_KV_PREFIX.length);
      if (sub.startsWith(orgPrefix)) continue; // already org-scoped (idempotency guard)
      insertKv.run(
        `${GITHUB_ACCOUNTS_KV_PREFIX}${PERSONAL_ORGANIZATION_ID}:${sub}`,
        row.value,
        row.updated_at
      );
    }

    // 5. Provider config: the global app_settings 'providerConfigs' row -> Personal org settings.
    const providerConfigsRow = connection
      .prepare(`SELECT value FROM app_settings WHERE key = 'providerConfigs'`)
      .get() as { value: string } | undefined;
    if (providerConfigsRow) {
      connection
        .prepare(
          `INSERT OR IGNORE INTO organization_settings (organization_id, key, value, updated_at)
           VALUES (?, 'providerConfigs', ?, unixepoch())`
        )
        .run(PERSONAL_ORGANIZATION_ID, providerConfigsRow.value);
    }

    // 6. Record the migration version so this no-ops on subsequent boots.
    connection
      .prepare(`INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, unixepoch())`)
      .run(ORG_MIGRATION_KV_KEY, ORG_MIGRATION_VERSION);
  })();
}

function rekeyKv(connection: BetterSqlite3.Database, oldKey: string, newKey: string): void {
  connection
    .prepare(
      `INSERT OR IGNORE INTO kv (key, value, updated_at) SELECT ?, value, updated_at FROM kv WHERE key = ?`
    )
    .run(newKey, oldKey);
}
