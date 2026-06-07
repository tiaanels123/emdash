import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';
import { PERSONAL_ORGANIZATION_ID, PERSONAL_ORGANIZATION_NAME } from '@shared/organizations';

describe('0016 organizations migration', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  it('creates the organizations and organization_settings tables', async () => {
    fixture = await openFixture('pre-0016');

    const tables = fixture.sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain('organizations');
    expect(names).toContain('organization_settings');
  });

  it('adds a non-null organization_id column to projects defaulting to the Personal org', async () => {
    fixture = await openFixture('pre-0016');

    const columns = fixture.sqlite.prepare(`PRAGMA table_info(projects)`).all() as {
      name: string;
      notnull: number;
      dflt_value: string | null;
    }[];

    const organizationId = columns.find((c) => c.name === 'organization_id');
    expect(organizationId).toBeDefined();
    expect(organizationId!.notnull).toBe(1);
    expect(organizationId!.dflt_value).toBe(`'${PERSONAL_ORGANIZATION_ID}'`);
  });

  it('creates the default Personal organization', async () => {
    fixture = await openFixture('pre-0016');

    const org = fixture.sqlite
      .prepare(`SELECT id, name FROM organizations WHERE id = ?`)
      .get(PERSONAL_ORGANIZATION_ID) as { id: string; name: string } | undefined;

    expect(org).toBeDefined();
    expect(org!.name).toBe(PERSONAL_ORGANIZATION_NAME);

    const [{ count }] = fixture.sqlite
      .prepare(`SELECT COUNT(*) AS count FROM organizations`)
      .all() as { count: number }[];
    expect(count).toBe(1);
  });

  it('reparents every pre-existing project under the Personal org with no data loss', async () => {
    fixture = await openFixture('pre-0016');

    // The pre-0016 fixture has two projects created before the migration.
    const [{ total }] = fixture.sqlite.prepare(`SELECT COUNT(*) AS total FROM projects`).all() as {
      total: number;
    }[];
    expect(total).toBe(2);

    const [{ orphaned }] = fixture.sqlite
      .prepare(
        `SELECT COUNT(*) AS orphaned FROM projects WHERE organization_id IS NULL OR organization_id != ?`
      )
      .all(PERSONAL_ORGANIZATION_ID) as { orphaned: number }[];
    expect(orphaned).toBe(0);
  });

  it('records the organization migration version so it is idempotent', async () => {
    fixture = await openFixture('pre-0016');

    const row = fixture.sqlite
      .prepare(`SELECT value FROM kv WHERE key = 'organization_migration_version'`)
      .get() as { value: string } | undefined;

    expect(row?.value).toBe('1');
  });
});
