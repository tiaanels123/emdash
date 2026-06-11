# Org → Task → Multi-Repo Implementation Brief

Goal: invert the hierarchy from `org → project → tasks` to `org → tasks → 1..N projects/repos`.
A task is owned by an organization, attaches one or more repositories (each getting its own
worktree/workspace), and the agent (e.g. Claude Code) works across all attached repos in one
session.

## Design decisions

1. **Additive data model, no table rebuild.** Follow the repo's deprecate-in-place convention:
   - `tasks.organization_id text NOT NULL DEFAULT <PERSONAL_ORGANIZATION_ID>` — same recipe as
     migration 0016 (`ADD COLUMN` with constant default, intentionally **no FK**, kv-gated data
     backfill derives the real org via `tasks.project_id → projects.organization_id`).
   - New join table **`task_projects`** `(task_id, project_id, workspace_id, sort_order)` with
     PK `(task_id, project_id)`. `sort_order = 0` is the **primary** repo. Backfill:
     `INSERT OR IGNORE INTO task_projects SELECT id, project_id, workspace_id, 0 FROM tasks`.
   - `tasks.project_id` and `tasks.workspace_id` are **kept** and now mean "primary repo" /
     "primary workspace". All existing single-repo plumbing (PTY session ids
     `${projectId}:${taskId}:${leafId}`, conversations/terminals rows, event payloads,
     navigation params, telemetry) keeps using the primary project. This avoids breaking the
     cross-process PTY-id contract and ~10 typed event channels.

2. **Same-org constraint.** All repos attached to a task must belong to one organization;
   `tasks.organization_id` is that org. Validated in `prepareCreateTask`
   (`CreateTaskError: { type: 'cross-org-repos' }`).

3. **v1 scope limits** (explicitly deferred):
   - Additional repos require **local** projects (no SSH/BYOI multi-repo;
     `{ type: 'multi-repo-requires-local' }` error). SSH same-host support later.
   - Task view diff/editor UI stays bound to the **primary** workspace; additional repos shown
     as info chips. Full per-repo diff UI is a follow-up.
   - Automations stay single-project.
   - Search FTS schema unchanged (tasks keep project_id).
   - Sidebar keeps project→task nesting; an org-level flat **Tasks** section is added above
     Projects (mirrors the pinned-strip pattern).

4. **Agent multi-repo access.** Conversation cwd stays the primary worktree. Additional
   worktree paths flow into the conversation provider, which:
   - auto-trusts each extra path (claude/cursor trust services),
   - writes hook config into each extra worktree,
   - appends `--add-dir <path>` per extra path via a new optional
     `AgentProviderDefinition.addDirFlag` (claude: `--add-dir`), passed through
     `buildAgentSessionCommand` extra session args so it applies to fresh + resume spawns.
   Providers without the flag silently degrade to primary-repo visibility.
   Env gains `EMDASH_REPO_PATHS` (path-list of all worktrees).

5. **Provisioning.** `provisionWorkspace(taskId)` loops attachments ordered by `sort_order`:
   primary exactly as today (produces the TaskProvider), then each additional repo runs the
   same `ensureWorkspaceSetup` against **its own** project provider (own worktree pool:
   `<worktreeDir>/<project>/<branch>`; same generated branch name across repos is fine).
   Additional workspaces are acquired in `workspaceRegistry` (lifecycle scripts/git stats run
   per repo). `task:provisioned` hook fires **once per attachment** (git watchers + PR sync
   already tolerate N workspaces per project). `taskSessionManager` persistData stores all
   workspace ids; teardown releases all.

6. **Create flow.** `CreateTaskParams` gains
   `additionalRepos?: Array<{ projectId: string; workspaceConfig: WorkspaceConfig }>` —
   additive, existing callers unchanged. The modal builds per-repo configs: worktree mode →
   `create-branch` with the same branch name from each repo's default branch; no-worktree mode
   → that repo's `repositoryWorkspaceId`.

7. **Deletion semantics.** Deleting a task removes all attachment worktrees/workspaces
   (sibling checks via `task_projects` + legacy `tasks.workspace_id`). Deleting a project:
   tasks whose **primary** repo it is are deleted (current behavior); tasks where it is a
   **secondary** repo are detached (join rows + that repo's workspace cleaned). FKs are
   unenforced at runtime — all cleanup is operation-layer (incl. legacy-port
   `destination-cleanup.ts`, `beta-import.ts` COPY_TABLE_ORDER).

8. **Org resolution.** Provider-settings org lookup at spawn keeps
   `getProjectOrganizationId(primary projectId)` — equivalent to the task org by constraint #2.

## Phases

- **A — Schema/migration**: copy `tooling/fixtures/baseline.db → pre-0018.db` FIRST; schema.ts
  changes; `pnpm run db:generate` (0018); kv-gated `ensureTaskOrganizations` data migration
  wired in `initialize.ts`; seeds + `pnpm run db:fixtures`; migration tests (0016-style PRAGMA
  assertions + data-migration idempotency test); legacy-port importers write
  `organization_id` + join rows.
- **B — Main process**: shared types (Task.organizationId, Task.repos, params, events
  additive; registry `addDirFlag`); createTask op; getTasks join; bootstrap loop;
  session-manager/teardown; conversation providers (trust/hooks/--add-dir); delete/archive;
  project-delete detach.
- **C — Renderer**: create-task modal repo multi-select (org-scoped); task manager passthrough;
  sidebar org Tasks section; task-view repo chips.
- **D — Gate**: format (changed files only), lint, typecheck, test, test:migrations; graphify
  update.

## Verified constraints from the audit

- `PRAGMA foreign_keys` never enabled → declared cascades are inert; never rely on them.
- Never hand-edit `drizzle/NNNN_*.sql` or `drizzle/meta/`; journal ordering is by `when`.
- `src/shared/logger.ts` must keep `import.meta.env?.` optional chaining or db:generate crashes.
- Versioned JSON columns: shape changes need a new `.version()`; raw-SQL backfills must write
  latest-version JSON by hand (we avoid touching them entirely in v1).
- Windows: don't run repo-wide `pnpm run format`; pre-existing failures in
  `mcp/utils/config-paths.test.ts`, `relational.test.ts`, `automation-scheduler.db.test.ts`
  are NOT regressions.
- `resolveTask`/`resolveWorkspace` already ignore projectId — main git/fs/editor tier is
  workspace-keyed and multi-repo-safe as-is.
