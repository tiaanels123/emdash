import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureTaskOrganizations } from '@main/db/task-org-migration';
import { PERSONAL_ORGANIZATION_ID } from '@shared/organizations';

const ORG_X_ID = 'aaaaaaaa-0000-4000-8000-00000000000a';

describe('ensureTaskOrganizations', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  async function seedAndRun() {
    fixture = await openFixture('empty');
    const { sqlite } = fixture;
    // The production client never enables foreign_keys; disable it here too so
    // the orphaned-task fallback path (dangling project_id) can be exercised.
    sqlite.pragma('foreign_keys = OFF');

    sqlite
      .prepare(
        `INSERT INTO organizations (id, name, sort_order) VALUES (?, 'Org X', 1)`
      )
      .run(ORG_X_ID);
    sqlite
      .prepare(
        `INSERT INTO projects (id, organization_id, name, path) VALUES ('proj-x', ?, 'proj-x', '/tmp/proj-x')`
      )
      .run(ORG_X_ID);

    // Task in org-x's project (organization_id left at the column default),
    // a task with a workspace, and an orphaned task whose project is gone.
    sqlite
      .prepare(
        `INSERT INTO tasks (id, project_id, name, status, workspace_id)
         VALUES ('task-1', 'proj-x', 'one', 'in_progress', 'ws-1'),
                ('task-2', 'proj-x', 'two', 'todo', NULL),
                ('task-orphan', 'proj-gone', 'orphan', 'todo', NULL)`
      )
      .run();

    // openFixture already ran the migration once on the empty DB; reset the
    // gate so it re-processes the rows seeded above.
    sqlite.prepare(`DELETE FROM kv WHERE key = 'task_organization_migration_version'`).run();
    ensureTaskOrganizations(sqlite);
    return sqlite;
  }

  it('derives each task organization from its primary project', async () => {
    const sqlite = await seedAndRun();

    const orgs = sqlite
      .prepare(`SELECT id, organization_id FROM tasks ORDER BY id`)
      .all() as Array<{ id: string; organization_id: string }>;

    expect(orgs).toEqual([
      { id: 'task-1', organization_id: ORG_X_ID },
      { id: 'task-2', organization_id: ORG_X_ID },
      { id: 'task-orphan', organization_id: PERSONAL_ORGANIZATION_ID },
    ]);
  });

  it('seeds primary task_projects rows mirroring the legacy columns', async () => {
    const sqlite = await seedAndRun();

    const rows = sqlite
      .prepare(
        `SELECT task_id, project_id, workspace_id, sort_order FROM task_projects ORDER BY task_id`
      )
      .all() as Array<{
      task_id: string;
      project_id: string;
      workspace_id: string | null;
      sort_order: number;
    }>;

    expect(rows).toEqual([
      { task_id: 'task-1', project_id: 'proj-x', workspace_id: 'ws-1', sort_order: 0 },
      { task_id: 'task-2', project_id: 'proj-x', workspace_id: null, sort_order: 0 },
      { task_id: 'task-orphan', project_id: 'proj-gone', workspace_id: null, sort_order: 0 },
    ]);
  });

  it('is idempotent and never duplicates or clobbers attachment rows', async () => {
    const sqlite = await seedAndRun();

    // Simulate a provisioned secondary attachment, then re-run the migration.
    sqlite
      .prepare(
        `INSERT INTO task_projects (task_id, project_id, workspace_id, sort_order)
         VALUES ('task-1', 'proj-y', 'ws-y', 1)`
      )
      .run();
    sqlite.prepare(`DELETE FROM kv WHERE key = 'task_organization_migration_version'`).run();
    ensureTaskOrganizations(sqlite);

    const [{ count }] = sqlite
      .prepare(`SELECT COUNT(*) AS count FROM task_projects`)
      .all() as Array<{ count: number }>;
    expect(count).toBe(4);

    const primary = sqlite
      .prepare(`SELECT workspace_id FROM task_projects WHERE task_id = 'task-1' AND project_id = 'proj-x'`)
      .get() as { workspace_id: string | null };
    expect(primary.workspace_id).toBe('ws-1');

    const gate = sqlite
      .prepare(`SELECT value FROM kv WHERE key = 'task_organization_migration_version'`)
      .get() as { value: string } | undefined;
    expect(gate?.value).toBe('1');
  });
});
