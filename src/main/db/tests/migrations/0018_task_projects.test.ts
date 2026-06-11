import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';
import { PERSONAL_ORGANIZATION_ID } from '@shared/organizations';

describe('0018 task_projects migration', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  it('creates the task_projects table with its composite primary key', async () => {
    fixture = await openFixture('pre-0018');

    const tables = fixture.sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('task_projects');

    const columns = fixture.sqlite.prepare(`PRAGMA table_info(task_projects)`).all() as {
      name: string;
      notnull: number;
      pk: number;
    }[];
    const byName = new Map(columns.map((c) => [c.name, c]));
    expect(byName.get('task_id')?.pk).toBe(1);
    expect(byName.get('project_id')?.pk).toBe(2);
    expect(byName.get('workspace_id')?.notnull).toBe(0);
    expect(byName.get('sort_order')?.notnull).toBe(1);
  });

  it('adds a non-null organization_id column to tasks defaulting to the Personal org', async () => {
    fixture = await openFixture('pre-0018');

    const columns = fixture.sqlite.prepare(`PRAGMA table_info(tasks)`).all() as {
      name: string;
      notnull: number;
      dflt_value: string | null;
    }[];

    const organizationId = columns.find((c) => c.name === 'organization_id');
    expect(organizationId).toBeDefined();
    expect(organizationId!.notnull).toBe(1);
    expect(organizationId!.dflt_value).toBe(`'${PERSONAL_ORGANIZATION_ID}'`);
  });

  it('backfills every pre-existing task with its project organization', async () => {
    fixture = await openFixture('pre-0018');

    const [{ total }] = fixture.sqlite.prepare(`SELECT COUNT(*) AS total FROM tasks`).all() as {
      total: number;
    }[];
    expect(total).toBe(4);

    const [{ mismatched }] = fixture.sqlite
      .prepare(
        `SELECT COUNT(*) AS mismatched FROM tasks
         WHERE organization_id != (SELECT organization_id FROM projects WHERE projects.id = tasks.project_id)`
      )
      .all() as { mismatched: number }[];
    expect(mismatched).toBe(0);
  });

  it('seeds one primary attachment row per pre-existing task', async () => {
    fixture = await openFixture('pre-0018');

    const rows = fixture.sqlite
      .prepare(
        `SELECT t.id AS task_id, t.project_id, t.workspace_id,
                tp.project_id AS tp_project_id, tp.workspace_id AS tp_workspace_id, tp.sort_order
         FROM tasks t LEFT JOIN task_projects tp ON tp.task_id = t.id`
      )
      .all() as Array<{
      task_id: string;
      project_id: string;
      workspace_id: string | null;
      tp_project_id: string | null;
      tp_workspace_id: string | null;
      sort_order: number | null;
    }>;

    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.tp_project_id).toBe(row.project_id);
      expect(row.tp_workspace_id).toBe(row.workspace_id);
      expect(row.sort_order).toBe(0);
    }
  });

  it('records the task organization migration version so it is idempotent', async () => {
    fixture = await openFixture('pre-0018');

    const row = fixture.sqlite
      .prepare(`SELECT value FROM kv WHERE key = 'task_organization_migration_version'`)
      .get() as { value: string } | undefined;

    expect(row?.value).toBe('1');
  });
});
