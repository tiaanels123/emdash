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

## Implementation status

### Done (this branch)

1. **Schema/migration (0018)** — `tasks.organization_id` (NOT NULL default Personal, no FK,
   0016 recipe) + `task_projects (task_id, project_id, workspace_id, sort_order)` with PK
   `(task_id, project_id)`; indexes on `tasks.organization_id` and `task_projects.project_id`.
   - `src/main/db/task-org-migration.ts` — kv-gated (`task_organization_migration_version`)
     `ensureTaskOrganizations`: derives each task's org from its primary project, seeds the
     primary attachment row per task; ungated `backfillTaskOrganizations` shared with beta
     import. Wired into `initialize.ts` after `ensureDefaultOrganization`.
   - Fixtures: committed `pre-0018.db` snapshot; baseline seed inserts attachment rows;
     migration tests `0018_task_projects.test.ts` + `task-org-migration.test.ts` (29/29 green).
   - Legacy-port: relational importer writes attachment rows; `destination-cleanup.ts`
     deletes-by-primary / detaches-secondary; `beta-import.ts` copies `task_projects` and
     backfills imports from pre-0018 beta DBs.

2. **Shared types** — `Task.organizationId`, `Task.repos: TaskRepo[]` (primary first),
   `CreateTaskParams.additionalRepos`, `ProvisionTaskResult.repos`, new `CreateTaskError`
   variants `cross-org-repos` / `multi-repo-requires-local`,
   `AgentProviderDefinition.addDirFlag` (set to `--add-dir` for claude).

3. **Main process**
   - `createTask`: validates same-org + local-only for additional repos, inserts N workspace
     rows + N attachment rows in one transaction (primary mirrors the legacy task columns).
   - `WorkspaceBootstrapService`: path resolution extracted to `_resolveWorkspacePath`;
     `ensureAdditionalWorkspaceSetup` provisions+acquires a secondary repo WITHOUT building
     task providers; `ensureWorkspaceSetupForTask` provisions secondaries FIRST, updates
     attachment rows on path-key dedupe, then provisions the primary with
     `extraWorktreePaths`; releases acquired secondaries on any failure.
   - `taskSessionManager`: persistData stores additional workspaces; teardown releases all;
     `task:provisioned`/`task:torn-down` hooks fire once per attachment (git watchers, PR
     sync, telemetry see every repo).
   - `LocalConversationProvider`: trusts every worktree, writes hook config into every
     worktree, appends `--add-dir <path>` per extra worktree via extraSessionArgs (applies to
     fresh AND resume spawns); `EMDASH_REPO_PATHS` env lists all roots.
   - `deleteTask`/`archiveTask`: iterate all attachments; sibling checks
     (`task-lifecycle-utils`) consider both `tasks.workspaceId` and `task_projects`.
   - `deleteProject`: detaches the project from all task attachments.

4. **Renderer** — create-task modal "Additional repositories" section (other local repos of
   the primary's org; worktree mode reuses the task branch name from each repo's default
   branch, no-worktree mode attaches at repository root); task titlebar "+N" badge listing
   additional repos; `getTasks` returns `repos` per task.

### Remaining work (follow-ups, in rough priority order)

1. **Per-repo diff/editor UI** — the task view still binds to the primary workspace only
   (`useWorkspace()`/`useWorkspaceId()` in `task-view-context.tsx` is the single funnel; ~30
   consumers). Needs an active-repo selector or per-repo diff sections; `PrStore`/
   `DiffViewStore`/`FileModelLifecycleStore` instances per attachment.
2. **Org-level task list in the sidebar** — tasks still render nested under their primary
   project. A flat "Tasks" section for the active org (pinned-strip pattern) or a full
   sidebar IA inversion; also `taskOrderByProject` snapshot re-keying.
3. **PR aggregation per repo** — `getPullRequestsForTask` reads the primary workspace/branch
   only; multi-repo tasks should aggregate PRs across attachments (the per-attachment
   `task:provisioned` hook already feeds PR sync, so cached PRs exist).
4. **Per-repo terminals** — terminals spawn in the primary worktree; could take a target-repo
   cwd choice. Same for lifecycle-script status UI (N setup scripts run, one surface).
5. **SSH multi-repo** — same-host SSH repos could work (cd + --add-dir on the remote);
   cross-host needs a session-per-repo model. BYOI multi-repo unscoped.
6. **Automations** — still single-project; could mirror `additionalRepos` in task templates.
7. **Search/FTS** — task rows index the primary branch keywords only; could aggregate
   branches across attachments (needs `SEARCH_INDEX_VERSION` bump).
8. **Delete preflight per repo** — `getDeletePreflight` reports the primary repo's
   uncommitted changes/branch only; deletion itself already cleans all repos.
9. **Telemetry** — add `organization_id` (and `workspace_id`) to the sanitizer allowlist in
   `src/main/lib/telemetry.ts` if per-org dashboards are wanted.
10. **Org switch navigation guard** — switching the active org keeps a foreign org's task
    open (pre-existing behavior, more visible now that tasks are org-owned).

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
