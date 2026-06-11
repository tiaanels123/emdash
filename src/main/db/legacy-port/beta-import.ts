import type Database from 'better-sqlite3';
import { backfillTaskOrganizations } from '@main/db/task-org-migration';
import { clearDestinationDataPreservingSignIn } from './reset';
import {
  columnsForTable,
  quoteIdentifier,
  quoteSqliteString,
  tableExists,
  withForeignKeysDisabled,
} from './sqlite-utils';

const COPY_TABLE_ORDER = [
  'app_settings',
  'pull_request_users',
  'pull_requests',
  'pull_request_labels',
  'pull_request_assignees',
  'pull_request_checks',
  'ssh_connections',
  'projects',
  'project_remotes',
  'tasks',
  'task_projects',
  'conversations',
  'terminals',
  'messages',
  'editor_buffers',
] as const;

function copyTable(sqlite: Database.Database, tableName: string): void {
  if (!tableExists(sqlite, tableName) || !tableExists(sqlite, tableName, 'beta')) return;

  const destinationColumns = new Set(columnsForTable(sqlite, 'main', tableName));
  const sourceColumns = columnsForTable(sqlite, 'beta', tableName);
  const columns = sourceColumns.filter((column) => destinationColumns.has(column));
  if (columns.length === 0) return;

  const columnSql = columns.map(quoteIdentifier).join(', ');
  const quotedTable = quoteIdentifier(tableName);
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO ${quotedTable} (${columnSql}) SELECT ${columnSql} FROM beta.${quotedTable}`
    )
    .run();
}

function copyAttachedBetaTables(sqlite: Database.Database): void {
  clearDestinationDataPreservingSignIn(sqlite);
  for (const tableName of COPY_TABLE_ORDER) {
    copyTable(sqlite, tableName);
  }
  // Beta databases older than migration 0018 have no task_projects table (and
  // no tasks.organization_id values); derive both for the imported rows.
  if (tableExists(sqlite, 'task_projects')) {
    backfillTaskOrganizations(sqlite);
  }
}

export function copyAttachedBetaDatabaseIntoDestination(sqlite: Database.Database): void {
  copyAttachedBetaTables(sqlite);
}

export async function withBetaDatabaseAttached<T>(
  sqlite: Database.Database,
  betaDatabasePath: string,
  action: () => Promise<T>
): Promise<T> {
  sqlite.exec(`ATTACH DATABASE ${quoteSqliteString(betaDatabasePath)} AS beta`);

  try {
    return await action();
  } finally {
    sqlite.exec('DETACH DATABASE beta');
  }
}

export function importBetaDatabaseIntoDestination(
  sqlite: Database.Database,
  betaDatabasePath: string
): void {
  withForeignKeysDisabled(sqlite, () => {
    sqlite.exec(`ATTACH DATABASE ${quoteSqliteString(betaDatabasePath)} AS beta`);

    try {
      sqlite.transaction(() => {
        copyAttachedBetaTables(sqlite);
      })();
    } finally {
      sqlite.exec('DETACH DATABASE beta');
    }
  });
}
