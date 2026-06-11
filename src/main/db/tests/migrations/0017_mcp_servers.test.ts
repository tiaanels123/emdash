import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';
import { PERSONAL_ORGANIZATION_ID } from '@shared/organizations';

describe('0017 mcp_servers migration', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  it('creates the mcp_servers table', async () => {
    fixture = await openFixture('empty');

    const tables = fixture.sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as { name: string }[];

    expect(tables.map((t) => t.name)).toContain('mcp_servers');
  });

  it('has the expected columns', async () => {
    fixture = await openFixture('empty');

    const columns = fixture.sqlite.prepare(`PRAGMA table_info(mcp_servers)`).all() as {
      name: string;
      notnull: number;
      pk: number;
    }[];
    const byName = new Map(columns.map((c) => [c.name, c]));

    expect(byName.has('organization_id')).toBe(true);
    expect(byName.has('name')).toBe(true);
    expect(byName.has('config')).toBe(true);
    expect(byName.has('updated_at')).toBe(true);
    expect(byName.get('config')!.notnull).toBe(1);
  });

  it('uses a composite primary key of (organization_id, name)', async () => {
    fixture = await openFixture('empty');

    const columns = fixture.sqlite.prepare(`PRAGMA table_info(mcp_servers)`).all() as {
      name: string;
      pk: number;
    }[];
    const pkColumns = columns
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);

    expect(pkColumns).toEqual(['organization_id', 'name']);
  });

  it('persists and round-trips an org-scoped server row', async () => {
    fixture = await openFixture('empty');

    fixture.sqlite
      .prepare(
        `INSERT INTO mcp_servers (organization_id, name, config, updated_at) VALUES (?, ?, ?, ?)`
      )
      .run(
        PERSONAL_ORGANIZATION_ID,
        'srv',
        '{"name":"srv","transport":"stdio","providers":["claude"]}',
        1
      );

    const row = fixture.sqlite
      .prepare(`SELECT config FROM mcp_servers WHERE organization_id = ? AND name = ?`)
      .get(PERSONAL_ORGANIZATION_ID, 'srv') as { config: string } | undefined;

    expect(row).toBeDefined();
    expect(JSON.parse(row!.config).providers).toEqual(['claude']);
  });
});
