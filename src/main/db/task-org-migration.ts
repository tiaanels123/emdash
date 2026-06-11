import type BetterSqlite3 from 'better-sqlite3';
import { PERSONAL_ORGANIZATION_ID } from '@shared/organizations';

/**
 * One-time, idempotent data migration for org-owned multi-repo tasks. Runs on
 * every boot after the schema migrations, but no-ops once the version key is
 * recorded. Mirrors the `ensureDefaultOrganization` pattern (raw SQLite, no
 * Electron / Drizzle, table-existence guarded, single transaction).
 *
 * - Backfills `tasks.organization_id` from the primary project's organization
 *   (the schema migration's ADD COLUMN default only covers the Personal org).
 * - Seeds `task_projects` with one primary attachment row per existing task,
 *   mirroring the legacy `tasks.project_id` / `tasks.workspace_id` columns.
 */
const TASK_ORG_MIGRATION_KV_KEY = 'task_organization_migration_version';
const TASK_ORG_MIGRATION_VERSION = '1';

/**
 * Ungated backfill used by both the boot-time migration and the beta-DB import
 * (whose source rows may predate the task_projects table). Idempotent: the
 * UPDATE is a pure derivation and the INSERT is OR IGNORE on the composite PK.
 */
export function backfillTaskOrganizations(connection: BetterSqlite3.Database): void {
  // Derive each task's organization from its primary project. Falls back to
  // the Personal org for orphaned tasks (project row missing).
  connection
    .prepare(
      `UPDATE tasks SET organization_id = COALESCE(
         (SELECT organization_id FROM projects WHERE projects.id = tasks.project_id),
         ?
       )`
    )
    .run(PERSONAL_ORGANIZATION_ID);

  // Seed the primary attachment row for every task that lacks one.
  connection
    .prepare(
      `INSERT OR IGNORE INTO task_projects (task_id, project_id, workspace_id, sort_order)
       SELECT id, project_id, workspace_id, 0 FROM tasks`
    )
    .run();
}

export function ensureTaskOrganizations(connection: BetterSqlite3.Database): void {
  const hasTaskProjectsTable = connection
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_projects'`)
    .get();
  if (!hasTaskProjectsTable) return;

  const versionRow = connection
    .prepare(`SELECT value FROM kv WHERE key = ?`)
    .get(TASK_ORG_MIGRATION_KV_KEY) as { value: string } | undefined;
  if (versionRow?.value === TASK_ORG_MIGRATION_VERSION) return;

  connection.transaction(() => {
    backfillTaskOrganizations(connection);

    // Record the migration version so this no-ops on subsequent boots.
    connection
      .prepare(`INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, unixepoch())`)
      .run(TASK_ORG_MIGRATION_KV_KEY, TASK_ORG_MIGRATION_VERSION);
  })();
}
