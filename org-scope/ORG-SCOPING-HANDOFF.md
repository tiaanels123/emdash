# Org-Scoping Implementation — Handoff

> **STATUS: ALL 8 PHASES COMPLETE.** Phases 1–3 (foundation) and Phases 4–8 (integration credential org-scoping, GitHub multi-account, provider settings, MCP, per-org UI) are implemented on `feat/org-scoping-foundation` and gate-green (`typecheck` ✅, `lint` ✅, migrations 21/21 ✅, 307 domain tests pass; the only remaining test failures are pre-existing Windows path-separator assertions in `mcp/utils/config-paths.test.ts`, unmodified vs `main`). The "Phases 4–8 REMAINING" sections below are retained as the historical implementation plan/contracts — they describe what was built, not outstanding work.

> Picking this up? Read this whole doc, then `ORG-SCOPING-IMPLEMENTATION-BRIEF.md` (the original spec) and `ARCHITECTURE.md`. The brief is the *what*; this doc is the *current state, the decisions made, the contracts already established, and exactly what's left*.

## TL;DR

Implementing organization-scoped projects & integrations per `ORG-SCOPING-IMPLEMENTATION-BRIEF.md`. User chose **everything in the brief** (incl. GitHub multi-account + MCP), across 8 phases.

- **Phases 1–3 DONE, validated, committed, and pushed.**
  - Branch: **`feat/org-scoping-foundation`** (off `main`), commit `1bf31a8e6`, pushed to `origin` (`tiaanels123/emdash`).
  - Organizations now exist as a first-class layer above projects; projects are reparented; the renderer has a working org switcher + grouping.
  - Gate green: `typecheck` ✅, `lint` ✅, migration tests (17/17) ✅, org domain test (9/9) ✅, touched project tests ✅.
- **Phases 4–8 REMAINING** (integration credential org-scoping, GitHub multi-account, provider settings, MCP, per-org UI). Details below.

There are condensed notes in the auto-memory: `org-scoping-feature.md` and `emdash-build-test-gotchas.md` (under `~/.claude/projects/C--Projects-emdash/memory/`).

---

## How to resume

```bash
git checkout feat/org-scoping-foundation   # the work is here, NOT on main
```

Merge gate (run these between phases; each phase must stay green):
```bash
pnpm run typecheck
pnpm run lint
pnpm run test:migrations                    # migration tests
pnpm exec vitest run --project main-db <file>   # db integration tests
pnpm exec vitest run --project node <file>      # unit tests
```
**Do NOT run `pnpm run format`** (see Gotchas). **Do NOT run `pnpm run test` blindly** — there are pre-existing unrelated failures (see Gotchas).

`gh` note: the repo owner is `tiaanels123`; the active `gh` account may need switching (`gh auth switch --user tiaanels123`) to push — the other account (`tiaan-1234`) lacks push rights.

---

## Decisions locked (from the user)

1. **Naming:** "Organization" (table `organizations`, namespace `rpc.organizations.*`).
2. **Org deletion:** block when non-empty **by default**, **plus** an explicit cascade-delete-with-confirmation path. The **Personal org can never be deleted**.
3. **Moving projects between orgs:** **deferred** (no `moveProjectToOrganization` yet).
4. **Scope:** everything in the brief, incl. GitHub multi-account and MCP.

---

## ⚠️ Established contracts — Phases 4–7 MUST match these exactly

The Phase-1 data migration (`src/main/db/org-data-migration.ts`, `ensureDefaultOrganization()`) **already re-keyed all existing credentials** into org-scoped keys for the Personal org. When you org-scope each integration, you MUST read/write under the **same** key scheme, or migrated credentials will appear disconnected.

| Concern | Global key (legacy) | Org-scoped key the migration produced | Helper |
|---|---|---|---|
| Issue-tracker tokens (linear/jira/asana/plain/featurebase) | `emdash-<name>-token` | `emdash-<name>-token:<orgId>` | `orgScopedSecretKey(orgId, baseKey)` |
| Monday/Trello credential blob | `emdash-monday-credentials` / `emdash-trello-credentials` | `…:<orgId>` | `orgScopedSecretKey` |
| GitLab / Forgejo token | `emdash-gitlab-token` / `emdash-forgejo-token` | `…:<orgId>` | `orgScopedSecretKey` |
| Jira non-secret creds (KV) | `jira:creds` | `jira:<orgId>:creds` | `new KV(\`jira:${orgId}\`)`, key `'creds'` |
| GitLab connection (KV) | `gitlab:connection` | `gitlab:<orgId>:connection` | `new KV(\`gitlab:${orgId}\`)`, key `'connection'` |
| Forgejo connection (KV) | `forgejo:connection` | `forgejo:<orgId>:connection` | `new KV(\`forgejo:${orgId}\`)`, key `'connection'` |
| GitHub per-account token | `github-account-token:<accountId>` | `github-account-token:<orgId>:<accountId>` | extend `tokenSecretKey()` |
| GitHub accounts metadata (KV) | `githubAccounts:<k>` (`accounts`/`defaultAccountId`/`removedCliAccounts`) | `githubAccounts:<orgId>:<k>` | `new KV(\`githubAccounts:${orgId}\`)` |
| Provider config | `app_settings` row `providerConfigs` | `organization_settings(orgId, 'providerConfigs', value)` | new org-settings store |

**Stay GLOBAL (never org-scope):** `emdash-account-token` (account login) and `emdash-github-token` (legacy github migration token). They're in `PRESERVED_SECRET_KEYS` in `src/main/db/legacy-port/reset.ts`.

Key constants:
- `PERSONAL_ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001'` (`src/shared/organizations.ts`) — also the DB default for `projects.organization_id`.
- `orgScopedSecretKey(organizationId, baseKey) => \`${baseKey}:${organizationId}\`` (`src/main/core/secrets/org-scoped-secret-key.ts`).

If you change the migration's key schemes, bump `ORG_MIGRATION_VERSION` in `org-data-migration.ts` and add a re-migration; otherwise just match them.

---

## Threading model (how orgId flows)

Two distinct paths — keep them straight:

1. **Settings / connect-disconnect-status flows (active org):** the renderer passes the **active organization** id. Source: `getActiveOrganizationId()` from `@renderer/features/organizations/stores/organization-selectors` (falls back to Personal before load). All connect/disconnect/checkConnection RPC calls take `organizationId` and the central chokepoint is `src/renderer/features/integrations/integrations-provider.tsx` (`PROVIDER_CONNECTION_CONFIG`). Add `organizationId` to react-query keys (`ISSUE_CONNECTION_STATUS_QUERY_KEY`, `['mcp','all']`, `['providerSettings', …]`) so switching orgs refetches.

2. **Operation resolution (issue listing/linking, PR creation):** resolve the org from the **project**, not the active org. Read `projects.organizationId` for the project. You'll need a helper like `getProjectOrganizationId(projectId): Promise<string>`. The GitHub funnel today is `resolveProjectGitHubAuthContext(projectId)` → must filter accounts to the project's org.

**Caches are the #1 bug risk.** Every connection service has in-memory token/client caches (`cachedToken`, `client`, `clientToken`, `cachedCredentials`). They are singletons assuming ONE credential — convert each to a `Map<organizationId, …>` (or invalidate on org switch), or you get cross-org credential bleed. Same for `octokit-cache.ts` (`${host}:${accountId}` → add orgId) and the GitLab/Forgejo `this.client`/`this.clientKey`.

Decision to make: thread `organizationId` as an explicit method/RPC arg (recommended; matches what the renderer already does) vs. a main-process "active org" service (races across windows — avoid). The foundation uses explicit args.

---

## What's DONE (Phases 1–3) — files & specifics

### Phase 1 — Data model & migration
- `src/shared/organizations.ts` — `Organization`, `Create/UpdateOrganizationParams`, `OrganizationError`, `DeleteOrganizationOptions`, `PERSONAL_ORGANIZATION_ID/NAME`, `isPersonalOrganization()`.
- `src/main/db/schema.ts` — `organizations` + `organizationSettings(organizationId,key,value,updatedAt; PK(orgId,key); FK cascade)` tables; `projects.organizationId text NOT NULL DEFAULT '<personal>'` (**no FK** — SQLite forbids ADD COLUMN REFERENCES + non-null default, and FKs are unenforced at runtime anyway) + index. Row-type exports added.
- Migration `drizzle/0016_tense_pet_avengers.sql` (plain ADD COLUMN, backfills existing rows).
- `src/main/core/secrets/org-scoped-secret-key.ts` — the helper.
- `src/main/db/org-data-migration.ts` — `ensureDefaultOrganization(connection)`: idempotent (kv key `organization_migration_version`), guarded on the `organizations` table existing, runs **after** migrations in `src/main/db/initialize.ts`. Creates Personal org, backfills projects, re-keys secrets/KV/providerConfigs (copies ciphertext — uses raw SQL, no decrypt, so no `safeStorage`/re-auth needed).
- Tests: `src/main/db/tests/migrations/0016_organizations.test.ts`, `…/org-data-migration.test.ts`.

### Phase 2 — Backend domain & reparenting
- `src/main/core/organizations/` — `organization-row.ts` (`toOrganization` mapper) + `operations/` (`createOrganization`, `listOrganizations`, `getOrganization`, `updateOrganization`, `deleteOrganization`, `reorderOrganizations`) + `controller.ts`. Registered as `organizations: organizationsController` in `src/main/rpc.ts`.
  - `deleteOrganization(id, { cascade })`: returns `Result<void, OrganizationError>`. Blocks `is_personal`, `not_found`, `not_empty` (with `projectCount`); cascade calls `deleteProject` per project then deletes the org + its `organization_settings` (manual cascade since FKs are off).
  - `updateOrganization` covers rename (and color/icon/sortOrder).
- Projects org-aware:
  - `src/shared/projects.ts` — `organizationId` added to `LocalProject`/`SshProject` and **required** on `CreateLocalProjectParams`/`CreateSshProjectParams` (RPC boundary).
  - `create-local-project.ts`/`create-ssh-project.ts` op-level param made `organizationId?: string` defaulting to Personal (mirrors the existing `id?` pattern; keeps tests/legacy simple while the renderer is forced to pass it at the boundary).
  - `getProjects.ts` — refactored to one `toProject(row)` mapper; added `listProjectsForOrganization(orgId)`.
  - Test schemas in `legacy-port/{relational,service}.test.ts` gained `organization_id` (drizzle now inlines the column default in inserts).
- Test: `src/main/core/organizations/operations/organizations.db.test.ts` (mocks `@main/db/client` to a fixture + stubs `deleteProject`).

### Phase 3 — Renderer
- `src/renderer/features/organizations/stores/organization-manager.ts` — `OrganizationManagerStore` (mirrors `SshConnectionStore`): list `Resource` + `activeOrganizationId` + `activeOrganization`/`activeId` computeds (fall back to first org) + CRUD (optimistic via `Resource.setValue`) + `snapshot`/`restoreSnapshot`.
- `…/stores/organization-selectors.ts` — `getOrganizationManagerStore`, `getActiveOrganization`, `getActiveOrganizationId()`.
- `src/renderer/lib/stores/app-state.ts` — registered `organizations` (constructed **before** projects) + snapshot `'organizations'`.
- `src/renderer/main.tsx` — loads orgs + restores active-org snapshot in bootstrap.
- UI: `…/components/OrganizationSwitcher.tsx` (in `left-sidebar.tsx`, dropdown: switch / new / rename / delete-with-cascade-confirm) + `OrganizationModal.tsx` (registered `organizationModal` in `modal-registry.ts`).
- `src/renderer/features/sidebar/sidebar-store.ts` — `orderedProjects` filters by active org. **NOTE:** the project store still loads ALL projects (`getProjects`); the sidebar filters in-memory. Org switching is instant (re-filter). If you'd rather lazy-load per org, switch `_doLoad` to `listProjectsForOrganization(activeId)` and refetch on org switch (heavier).
- `project-manager.ts` createProject calls pass `getActiveOrganizationId()`.

---

## What's LEFT (Phases 4–8)

> A full recon of every subsystem was done (exact signatures, file:line). The actionable distillation is below. Linear is the cleanest reference for issue trackers.

### Phase 4 — Issue trackers + GitLab/Forgejo
**This is all-or-nothing for the build:** `rpc.issues.checkAllConnections()` (`src/main/core/issues/controller.ts`) aggregates *every* provider's `checkConnection()`, and the renderer chokepoint `integrations-provider.tsx` wires all of them — so you can't org-scope just one and stay green.

Per service (`src/main/core/<name>/<name>-connection-service.ts` + `controller.ts`), thread `organizationId`:
- Replace the global secret-key constant usage with `orgScopedSecretKey(organizationId, BASE_KEY)`.
- Convert caches to `Map<organizationId, …>`.
- Controllers add `organizationId` as the first arg of `saveToken/saveCredentials`, `clearToken/clearCredentials`, `checkConnection`.
- Issue providers (`<name>-issue-provider.ts`, used for issue listing) resolve the org from the project (see Threading §2) before calling `getClient(orgId)`.

Per-integration specifics (verbatim from recon):
| Integration | Secret key | Storage shape | Notes |
|---|---|---|---|
| **linear** (reference) | `LINEAR_TOKEN_SECRET_KEY='emdash-linear-token'` | token only | `saveToken/clearToken/checkConnection/getClient/getStoredToken`; `cachedToken`+`client`+`clientToken` caches; telemetry on connect/disconnect |
| **asana** | `'emdash-asana-token'` | token only (+ in-mem workspace gid) | same shape |
| **plain** | `'emdash-plain-token'` | token only | **no telemetry**; `saveToken` returns no displayName |
| **featurebase** | `'emdash-featurebase-token'` | token only | **no telemetry** |
| **jira** | `'emdash-jira-token'` | token in secret **+ `KV('jira')` key `creds` = `{siteUrl,email}`** | org-scope BOTH; `saveCredentials(siteUrl,email,token)`, `requireAuth()` chokepoint |
| **monday** | `CREDENTIALS_KEY='emdash-monday-credentials'` (module const) | token+boardIds+boardUrls as **one JSON blob in the secret** | `saveCredentials({token,boardUrls})` |
| **trello** | `CREDENTIALS_KEY='emdash-trello-credentials'` (module const) | apiKey+token+boardIds as **one JSON blob in the secret** | `saveCredentials({apiKey,token,boardUrls})` |
| **gitlab** | `GITLAB_TOKEN_SECRET_KEY='emdash-gitlab-token'` | token in secret **+ `KV('gitlab')` key `connection`={instanceUrl}** | single-token, single-instance; `requireAuth()`/`resolveProject()` chokepoints; `this.client`/`this.clientKey` cache |
| **forgejo** | `FORGEJO_TOKEN_SECRET_KEY='emdash-forgejo-token'` | token + `KV('forgejo')` key `connection` | mirrors gitlab; `resolveRepo()` |

Renderer: `integrations-provider.tsx` `PROVIDER_CONNECTION_CONFIG` (per-provider `connectMutationFn`/`disconnectMutationFn`) + `rpc.issues.checkAllConnections` → thread active org; add org to react-query keys. GitLab/Forgejo issue providers currently receive only `projectPath` (no projectId) — you must thread projectId/org through `src/main/core/issues/registry.ts` provider options.

### Phase 5 — GitHub multi-account (hardest)
GitHub is already multi-account. Key files (`src/main/core/github/`):
- `accounts/github-account-registry.ts` — `tokenSecretKey(accountId) => 'github-account-token:'+accountId` → make `github-account-token:<orgId>:<accountId>`. Account metadata KV namespace `githubAccounts` → per-org `githubAccounts:<orgId>`.
- `accounts/github-account-registry-instance.ts` — wires the KV namespace + secret store.
- `services/github-api-auth-service.ts` `getToken(host,{accountId})`, `services/octokit-provider.ts` `getOctokit(host,{accountId})`, `services/octokit-cache.ts` (cache key `${host}:${accountId}` → add orgId).
- `services/project-github-auth-context-resolver.ts` / `project-github-auth-context.ts` — `resolveProjectGitHubAuthContext(projectId)` (project→accountId via `project.settings.githubAccountId`). Filter to the project's org's accounts.
- `pull-requests/pr-sync-engine.ts` (`authContextKey()`, `getOctokit` in create/merge/etc.), `pr-sync-scheduler.ts`, `github-issue-provider.ts`, `repo-service.ts`, `issue-service.ts` — all resolve via the above; add org dimension to cache keys.
- `accounts/github-account-reconciliation.ts` (`reconcileAtStartup()` at `src/main/index.ts:163`), `github-account-backfill.ts`, `project-github-account-backfill.ts`, `github-device-flow-service.ts`, `github-cli-account-import.ts` — account creation/backfill must be org-aware (which org owns a newly connected account = the active org passed from the renderer).
- Renderer: `src/renderer/features/settings/components/GitHubAccountsSection.tsx` + `github-connect-modal.tsx` (GitHub auth lives at the **account layer**, not the integrations-provider chokepoint — separate design). `rpc.projects.countProjectsUsingGithubAccount` and `src/main/core/projects/settings/count-projects-using-github-account.ts` may need org filtering.
- Update `PRESERVED_SECRET_KEYS` in `legacy-port/reset.ts` if you want org-scoped github keys preserved on reset (currently only the legacy single key is).
- Note: `git push`/clone use **system git credentials**, not in-app tokens — out of scope.

### Phase 6 — Provider settings (org-scoped)
- `organization_settings` table is already created and the migration already copied the global `providerConfigs` row into Personal's org settings.
- `src/main/core/settings/` — `provider-settings-service.ts` (`providerOverrideSettings = new OverrideSettings('providerConfigs', …)`), `override-settings.ts` (generic store over `app_settings` by `storageKey`), `controller.ts`/`provider-settings-controller.ts`. Both `SettingsStore` and `OverrideSettings` have **global in-memory caches** that must become per-org (`Map<orgId,…>`), and all reads/writes must add the org dimension. Build an org-scoped variant backed by `organization_settings` (keyed by `(organizationId, key)`), or generalize `OverrideSettings` to take an org. Thread `organizationId` through `rpc.providerSettings.*`.
- Renderer: `src/renderer/features/settings/use-provider-settings.ts`, `app-settings-client.ts` — add org to react-query keys.
- Decide which app settings are org-scoped vs global. The brief wants provider config per-org; app-level UI settings (theme/terminal) should stay global. The `organization_settings` table is the home for org-scoped settings.

### Phase 7 — MCP per-org (new architecture)
**MCP has NO emdash DB/secret backing** — `McpService` reads/writes each agent's *global home-dir config file* (`~/.claude.json`, `~/.codex/config.toml`, `~/.cursor/mcp.json`, …) via `src/main/core/mcp/utils/config-io.ts` + `config-paths.ts` (`AGENT_CONFIGS`). Credentials are plaintext in those files.
- True per-org isolation needs a NEW emdash-owned store as source of truth (e.g. `mcp_servers(organizationId, name, McpServer JSON, providers)` table) + a **materialize step**: on org switch / save, write the active org's servers into the agents' config files (preserving non-emdash keys + TOML/JSONC) and strip the previous org's. Track provenance (which server names emdash added) to avoid clobbering user-managed servers.
- During migration/first run, IMPORT current on-disk servers into the Personal org so nothing is lost.
- `McpService.loadAll/saveServer/removeServer` + `mcp/controller.ts` + renderer `features/mcp/components/useMcps.ts` (query keys `['mcp','all']`/`['mcp','providers']`) all need `organizationId`. `McpView.tsx` copy ("remove from all agents") assumes global.

### Phase 8 — Per-org integration settings UI, commands, final gate
- Move integration/settings/MCP UI into per-org context (active org determines visible credentials): `features/integrations/`, `features/settings/` (`SettingsPage.tsx` integrations tab), `features/mcp/`.
- Org management polish; command-palette org commands (`src/renderer/lib/commands/`); `setupViewCommandProvider` only re-registers the hardcoded `'task'` scope today.
- A new ViewId (if you add an org settings view) must be added in THREE places: `app/view-registry.ts`, `viewEvents` in `lib/stores/navigation-store.ts`, and `isLibraryView` grouping if relevant.
- Final gate + manual verification: existing DB migrates → all projects under Personal, all integrations still connected.

---

## Acceptance criteria (from the brief) — track these
- Create/rename/reorder/delete orgs (✅ done; deletion blocks non-empty + cascade option ✅).
- Create projects inside a specific org; project list grouped/scoped (✅ done).
- Connecting an integration in one org does not affect another; independent credentials/config per org (⏳ Phases 4–7).
- Integration-dependent actions (PR creation, issue linking, MCP) resolve credentials via the **project's** org (⏳ Phases 4–7, Threading §2).
- Existing DBs migrate: all prior projects under Personal, integrations still connected, no loss (✅ migration done; verify per integration as you scope it).
- Migration idempotent & safe to re-run (✅).
- Full merge gate green incl. new tests (⏳ keep it green each phase).

---

## ⚠️ Environment gotchas (will bite you)

- **Do NOT run repo-wide `pnpm run format`.** The installed `oxfmt` disagrees with the committed tree (toolchain mid-bump; user has uncommitted `package.json`/`pnpm-lock.yaml`) and reformats ~1400 files. Format only files you changed, or skip. The merge gate's `format` step is effectively broken locally.
- **CRLF/LF noise.** `core.autocrlf=true` + that one oxfmt run leaves hundreds of "modified" files in `git status` that are EOL-only (no content diff; git normalizes them away on commit). Find REAL changes with `git diff --numstat HEAD | awk '$1!="0"||$2!="0"'`. **Stage specific files; never `git add -A`.**
- **`pnpm run db:generate`** (drizzle-kit, CJS) needs `import.meta.env?.VITE_LOG_LEVEL` (optional chaining) in `src/shared/logger.ts` — already fixed; don't revert.
- **Migrations/fixtures** use `better-sqlite3` from `tooling/node-deps/` (system-Node compiled) via a Vitest alias — no native rebuild needed. Inspect `.db` files in plain node via `require('./tooling/node-deps/node_modules/better-sqlite3')`.
- **Fixture workflow when you add a migration (0017+):** `schema.ts` → `pnpm run db:generate` → write a `src/main/db/tests/migrations/00NN_*.test.ts` using `openFixture('pre-00NN')` → `pnpm run db:fixtures` (regenerates `tooling/fixtures/{baseline,empty}.db`) → `pnpm run test:migrations`. For a `pre-00NN` fixture, build an empty DB at the prior migration and raw-insert rows (the drizzle seed inlines new column defaults and fails against an older table). `openFixture` applies pending migrations **forward** (gated by journal `when` timestamps) — committed fixtures can be "behind"; that's fine. `tooling/utils/db.ts` had a Windows path bug (`new URL().pathname` → `C:\C:\…`), fixed to `fileURLToPath` — don't revert.
- **Pre-existing `main-db` test failures (NOT from this work):** `automation-scheduler.db.test.ts` queries `automation_runs.task_id` (removed in 0015); `legacy-port/.../relational.test.ts` hand-written `conversations` table lacks `agent_status`/`agent_status_seen` (added 0015). These fail on `main` too. Don't chase them; don't let them mask your own breakage (run targeted test files).
- **FKs are unenforced at runtime** (better-sqlite3 default off; migration PRAGMAs are no-ops inside the wrapping transaction). So `projects.organizationId` has no enforced FK, "block deletion" is app-level, and manual cascade is needed (see `deleteOrganization`).

---

## Reference

- Original spec: `ORG-SCOPING-IMPLEMENTATION-BRIEF.md`
- Architecture/conventions: `ARCHITECTURE.md`, `AGENTS.md`/`CLAUDE.md`
- Auto-memory (condensed): `~/.claude/projects/C--Projects-emdash/memory/org-scoping-feature.md`, `emdash-build-test-gotchas.md`
- RPC pattern: controllers in `src/main/core/*/controller.ts` (identity `createRPCController`), aggregated in `src/main/rpc.ts`; renderer calls `rpc.*` from `src/renderer/lib/ipc.ts`; `Result<T,E>` from `@shared/lib/result` (check `.success`, no `isOk`/`isErr` helpers). One operation per file.
