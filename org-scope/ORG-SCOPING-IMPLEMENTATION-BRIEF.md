# Implementation Brief: Organization-Scoped Projects & Integrations

## How to use this document

You are picking up a feature implementation on this codebase. **Before writing any code, read `CLAUDE.md` and `ARCHITECTURE.md`** in this repo — they describe the process model, the typed RPC/event layer, the data model, the domain structure, and the coding conventions you must follow. This brief assumes that context and references real files, tables, and domains by name.

Work in phases, keep the merge gate green between phases (`pnpm run format && pnpm run lint && pnpm run typecheck && pnpm run test`), and follow the existing patterns rather than introducing new ones.

---

## 1. Goal

Introduce an **Organization** layer above projects. Today the top-level entity is a project (one repository). The target model is:

```
Organization
└── Project (repository)
    └── Workspace (worktree) / Conversation / Task / PR / Automation
```

An organization groups multiple projects, and **each organization owns its own integration settings** (issue trackers, Git hosts, MCP). Today integrations are global to the whole app; after this change they are scoped per organization, so different organizations can connect to different Jira/Linear/GitHub accounts independently.

The motivation is multi-context organization: one organization per "job"/client, each holding that client's repositories and its own connected integrations.

---

## 2. Current state (grounded)

- **Projects are top-level.** The `projects` table (`src/main/db/schema.ts`) has no parent entity. `projectRemotes`, `projectSettings`, and `tasks` reference `projects` with cascade deletes; `workspaces`, `conversations`, and `messages` sit below.
- **Integration credentials are stored globally.** Each integration has a connection service — e.g. `src/main/core/linear/linear-connection-service.ts`, `src/main/core/github/services/github-connection-service.ts`, `src/main/core/jira/jira-connection-service.ts` — that persists its token through `encryptedAppSecretsStore` (`src/main/core/secrets/encrypted-app-secrets-store.ts`, backed by the `appSecrets` table + Electron `safeStorage`) under a **fixed, app-global key**. Example: Linear uses `LINEAR_TOKEN_SECRET_KEY = 'emdash-linear-token'`. One key → one credential for the entire app.
- **Non-secret provider config is global too.** The `settings` domain (`src/main/core/settings/`) manages it via `provider-settings-service.ts` / `provider-settings-controller.ts`, validated by `settings/schema.ts`, with config persisted globally (no org/project dimension).
- **Settings tables:** `appSettings` (global key/value), `projectSettings` (per-project), `appSecrets` (encrypted secrets). There is no organization-scoped settings store yet.
- **RPC surface:** controllers live in `src/main/core/*/controller.ts`, are aggregated in `src/main/rpc.ts` into `rpcRouter` (type `RpcRouter`), and the renderer calls them through the typed `rpc` client in `src/renderer/lib/ipc.ts`. Integration namespaces today: `jira`, `linear`, `asana`, `monday`, `trello`, `plain`, `featurebase`, `github`, `gitlab`, `forgejo`, `mcp`.

---

## 3. Scope

**In scope**
- A new `organizations` entity and the data model to support it.
- Reparenting projects under organizations (every project belongs to exactly one organization).
- Org-scoping all integration credentials and provider settings (issue trackers, Git hosts, MCP).
- A backend `organizations` domain + RPC surface.
- Frontend: organization concept, an org switcher, projects grouped by org, and per-org integration settings UI.
- A data migration that preserves all existing data and connections.

**Out of scope (do not change behavior here)**
- PTY/agent execution, worktree mechanics, conversation/message handling, and PR tracking below the project level — these stay as-is. They inherit organization context transitively through their project; they do not need their own `organizationId`.
- The agent provider registry, skills, and prompt library, unless an integration credential they read is one of the org-scoped ones (in which case they resolve it via the project's organization).

---

## 4. Data model changes

Add the new schema in `src/main/db/schema.ts` and generate a migration with `pnpm run db:generate` (migrations are generated into `drizzle/` — do not hand-write migration SQL; let drizzle-kit produce it, then add the data-migration step described in §7).

### 4.1 New `organizations` table

```ts
export const organizations = sqliteTable('organizations', {
  id: text('id').primaryKey(),                 // generated id, same scheme as other tables
  name: text('name').notNull(),
  color: text('color'),                        // optional, for UI
  icon: text('icon'),                          // optional, for UI
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});
```

### 4.2 `projects` gains an organization reference

Add `organizationId` to `projects`, referencing `organizations(id)`. Use the same on-delete behavior the rest of the schema uses for required parents, but see the deletion decision in §9 — deleting an organization that still contains projects is high-stakes, so prefer **blocking deletion of a non-empty organization** at the operation layer rather than silently cascading away projects, workspaces, and conversations.

### 4.3 Org-scoped integration settings

Two pieces, because integrations store two kinds of data:

1. **Secrets (tokens).** Keep using `encryptedAppSecretsStore`, but make the keys organization-scoped. Add a small helper that derives an org key, e.g. `orgScopedSecretKey(organizationId, baseKey)` → `` `${baseKey}:${organizationId}` ``, and route every integration connection service through it. Example: Linear's `'emdash-linear-token'` becomes `'emdash-linear-token:<organizationId>'`.

2. **Non-secret provider config.** Introduce an organization-scoped settings store rather than overloading global `appSettings`:

```ts
export const organizationSettings = sqliteTable('organization_settings', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  valueJson: text('value_json').notNull(),     // consider versionedJsonColumn() if the value is structured
}, (t) => ({
  orgKeyUnique: unique().on(t.organizationId, t.key),
}));
```

The `cascade` here is correct: deleting an organization should remove its settings (the projects themselves are protected separately per §9).

> Before finalizing this, audit the exact current storage in `src/main/core/settings/provider-settings-service.ts` and each `core/<integration>/*-connection-service.ts`, and mirror whatever shape they already use — adapt the above to reality rather than assuming.

---

## 5. Backend changes (`src/main/`)

### 5.1 New `organizations` domain

Create `src/main/core/organizations/` following the controller→operation pattern used by `conversations` and `projects`:
- `controller.ts` exposing operations: `createOrganization`, `listOrganizations`, `getOrganization`, `renameOrganization`, `updateOrganization` (color/icon/sortOrder), `deleteOrganization`, `reorderOrganizations`.
- One operation per file; use the `Result<T, E>` pattern (`src/main/lib/result.ts`) for expected failures (e.g. deleting a non-empty org).
- Register it in `src/main/rpc.ts` so it surfaces as `rpc.organizations.*`.

### 5.2 Make `projects` organization-aware

In `src/main/core/projects/`:
- `createProject` (and any import/clone flow) takes `organizationId`.
- Add `listProjectsForOrganization(organizationId)`; keep or adapt existing listing.
- Optionally add `moveProjectToOrganization(projectId, organizationId)` (see §9).

### 5.3 Org-scope every integration

For each integration domain — `linear`, `github`, `jira`, `asana`, `monday`, `trello`, `plain`, `featurebase`, `gitlab`, `forgejo`, `mcp` — update its connection service and controller so credential read/write and provider config are keyed by `organizationId`:
- Thread `organizationId` through `setSecret`/`getSecret`/`deleteSecret` calls via the `orgScopedSecretKey` helper.
- Thread `organizationId` through the `settings` domain's provider-settings service so non-secret config is read/written per organization.
- Update the corresponding RPC procedure signatures to accept `organizationId`.

Anything elsewhere that resolves an integration credential (e.g. PR creation, issue linking) must now resolve it via the **project's organization** rather than a global lookup.

---

## 6. Frontend changes (`src/renderer/`)

- **Organization model + store.** Add a MobX org store under `src/renderer/lib/stores/` (or `features/organizations/stores/`) with selectors, mirroring the project/task store patterns (`getProjectStore`, selectors, explicit `ready` state).
- **Org switcher + management UI.** Add a `features/organizations/` module: an organization switcher (sidebar/top-level), and create/rename/delete/reorder flows. Register any new views in `src/renderer/app/view-registry.ts` and modals in `src/renderer/app/modal-registry.ts`; wire commands in `src/renderer/lib/commands/registry.ts` if relevant.
- **Projects grouped under organizations.** Update the project list/sidebar (`features/projects/`) so projects are shown within the active organization (and creating a project assigns it to the active org). Calls go through `rpc.projects.*` with the org id.
- **Per-org integration settings.** Move the integrations UI (`features/integrations/`, `features/settings/`, `features/mcp/`) from app-global settings into per-organization settings, so each org has its own connect/disconnect/configure screens. The active organization determines which credentials are shown and edited.

---

## 7. Backward compatibility & data migration (critical)

Existing data must keep working with zero loss. After the schema migration, run a one-time data migration (in the DB initialization/migration path under `src/main/db/`):

1. **Create a default organization** (e.g. name `"Personal"`), generating an id.
2. **Reparent existing projects:** set `organizationId` on every existing project to the default organization.
3. **Migrate integration secrets:** for each known global integration secret key (e.g. `'emdash-linear-token'`, and the equivalents for jira, github, gitlab, forgejo, asana, monday, trello, plain, featurebase, mcp), copy its value to the org-scoped key (`'<baseKey>:<defaultOrgId>'`). Keep the old global key until the migration is verified, then remove it in a follow-up.
4. **Migrate provider settings:** copy existing global provider config into `organizationSettings` for the default organization.

Make the migration idempotent and guard it (e.g. skip if a default org already exists), so re-running on an already-migrated database is safe.

---

## 8. Conventions to follow

- **RPC:** new handlers in `core/*/controller.ts` delegating to operation functions; register in `src/main/rpc.ts`; renderer calls via `rpc`/`events` from `src/renderer/lib/ipc.ts`.
- **Errors:** `Result<T, E>` for expected failures.
- **DB:** generate migrations with `pnpm run db:generate`; don't hand-edit generated SQL. Use `versionedJsonColumn()` for structured JSON columns where appropriate.
- **State:** MobX stores accessed via selectors/hooks; model `ready` state explicitly.
- **Style:** oxfmt + oxlint (printWidth 100, 2 spaces, single quotes in TS, double in JSX, sorted imports); strict TypeScript; top-level imports only; components `PascalCase`, hooks `useX`.
- **Path aliases:** `@main/*`, `@renderer/*`, `@shared/*`, `@/*`, `@root/*`.
- **Commits:** Conventional Commits, e.g. `feat(organizations): scope integration credentials per organization`.
- **Tests:** colocate main-process tests (`src/main/core/organizations/**/*.test.ts`); add a migration test under the `migrations` Vitest project; add renderer tests under `src/renderer/tests/`.

---

## 9. Decisions to confirm before/while implementing

1. **Organization deletion.** Recommended: block deletion of an organization that still contains projects (return a `Result` error), forcing the user to move or remove projects first — safer than cascading away projects/workspaces/conversations. Confirm this versus an explicit "delete org and everything in it" path with a strong confirmation.
2. **Single active org vs. cross-org views.** Decide whether the UI always operates within one selected organization (simplest) or also offers an "all organizations" overview. Recommended: a single active organization with a switcher, plus an optional aggregate view later.
3. **Moving projects between organizations.** Decide whether projects can be reassigned to another organization after creation. If yes, implement `moveProjectToOrganization` and a UI affordance; note that moving a project does **not** move org-scoped integration credentials (the project will use the destination org's integrations).
4. **Naming.** Confirm user-facing terminology ("Organization" vs "Workspace" vs "Team") — avoid "Workspace," which already means a git worktree in this codebase.

---

## 10. Suggested order of work

1. Read `CLAUDE.md` and `ARCHITECTURE.md`.
2. Schema: add `organizations`, `projects.organizationId`, `organizationSettings`; generate the migration; add the §7 data migration; write and pass a migration test.
3. Backend: `organizations` domain + RPC; make `projects` org-aware.
4. Backend: org-scope one integration end to end (Linear is a clean reference — single token via `encryptedAppSecretsStore`), verify, then apply the same pattern to the rest.
5. Frontend: org store + switcher + project grouping.
6. Frontend: move integration settings into per-org UI.
7. Full pass of the merge gate; manual verification that existing data landed in the default org with integrations still connected.

---

## 11. Acceptance criteria

- A user can create, rename, reorder, and delete organizations (deletion behavior per §9).
- A user can create projects inside a specific organization; the project list is grouped/scoped by organization.
- Connecting an integration (e.g. Linear, GitHub, Jira) in one organization does **not** affect any other organization; each organization maintains independent credentials and provider config.
- Integration-dependent actions (PR creation, issue linking, MCP) resolve credentials via the project's organization.
- Existing databases migrate automatically: all prior projects appear under a default organization, and all previously connected integrations remain connected within that organization, with no data loss.
- The migration is idempotent and safe to re-run.
- `pnpm run format && pnpm run lint && pnpm run typecheck && pnpm run test` all pass, including new tests for the organizations domain and the migration.
