import { openFixture } from '@tooling/utils/db';
import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { orgScopedSecretKey } from '@main/core/secrets/org-scoped-secret-key';
import { ensureDefaultOrganization } from '@main/db/org-data-migration';
import { PERSONAL_ORGANIZATION_ID } from '@shared/organizations';

function secretFor(sqlite: BetterSqlite3.Database, key: string): string | undefined {
  return (
    sqlite.prepare(`SELECT secret FROM app_secrets WHERE key = ?`).get(key) as
      | { secret: string }
      | undefined
  )?.secret;
}

function kvFor(sqlite: BetterSqlite3.Database, key: string): string | undefined {
  return (
    sqlite.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as { value: string } | undefined
  )?.value;
}

function resetMigrationGate(sqlite: BetterSqlite3.Database): void {
  sqlite.prepare(`DELETE FROM kv WHERE key = 'organization_migration_version'`).run();
}

describe('ensureDefaultOrganization re-keying', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  it('copies legacy global credentials into Personal-org-scoped keys, preserving the originals', async () => {
    fixture = await openFixture('empty');
    const { sqlite } = fixture;

    sqlite
      .prepare(`INSERT INTO app_secrets (key, secret) VALUES (?, ?)`)
      .run('emdash-linear-token', 'cipher-linear');
    sqlite
      .prepare(`INSERT INTO app_secrets (key, secret) VALUES (?, ?)`)
      .run('github-account-token:github.com:42', 'cipher-gh');
    sqlite
      .prepare(`INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)`)
      .run('jira:creds', '{"siteUrl":"x"}', 1);
    sqlite
      .prepare(`INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)`)
      .run('gitlab:connection', '{"instanceUrl":"y"}', 1);
    sqlite
      .prepare(`INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)`)
      .run('githubAccounts:accounts', '[]', 1);
    sqlite
      .prepare(
        `INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('providerConfigs', ?, 1)`
      )
      .run('{"claude":{}}');

    resetMigrationGate(sqlite);
    ensureDefaultOrganization(sqlite);

    // Secrets: org-scoped copy exists and the original global key is preserved.
    expect(
      secretFor(sqlite, orgScopedSecretKey(PERSONAL_ORGANIZATION_ID, 'emdash-linear-token'))
    ).toBe('cipher-linear');
    expect(secretFor(sqlite, 'emdash-linear-token')).toBe('cipher-linear');
    expect(
      secretFor(sqlite, `github-account-token:${PERSONAL_ORGANIZATION_ID}:github.com:42`)
    ).toBe('cipher-gh');

    // KV connection config re-keyed under the org namespace.
    expect(kvFor(sqlite, `jira:${PERSONAL_ORGANIZATION_ID}:creds`)).toBe('{"siteUrl":"x"}');
    expect(kvFor(sqlite, `gitlab:${PERSONAL_ORGANIZATION_ID}:connection`)).toBe(
      '{"instanceUrl":"y"}'
    );
    expect(kvFor(sqlite, `githubAccounts:${PERSONAL_ORGANIZATION_ID}:accounts`)).toBe('[]');

    // Provider config moved into per-org settings.
    const providerConfigs = sqlite
      .prepare(
        `SELECT value FROM organization_settings WHERE organization_id = ? AND key = 'providerConfigs'`
      )
      .get(PERSONAL_ORGANIZATION_ID) as { value: string } | undefined;
    expect(providerConfigs?.value).toBe('{"claude":{}}');
  });

  it('is idempotent — re-running never double-scopes a key', async () => {
    fixture = await openFixture('empty');
    const { sqlite } = fixture;

    sqlite
      .prepare(`INSERT INTO app_secrets (key, secret) VALUES (?, ?)`)
      .run('github-account-token:github.com:42', 'cipher-gh');

    resetMigrationGate(sqlite);
    ensureDefaultOrganization(sqlite);
    resetMigrationGate(sqlite);
    ensureDefaultOrganization(sqlite);

    const ghKeys = (
      sqlite
        .prepare(`SELECT key FROM app_secrets WHERE key LIKE 'github-account-token:%'`)
        .all() as {
        key: string;
      }[]
    )
      .map((r) => r.key)
      .sort();

    expect(ghKeys).toEqual(
      [
        'github-account-token:github.com:42',
        `github-account-token:${PERSONAL_ORGANIZATION_ID}:github.com:42`,
      ].sort()
    );
  });
});
