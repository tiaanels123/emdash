# Org-Scoping — Completion Report

**Status: COMPLETE.** All 8 phases of the org-scoping feature (per `ORG-SCOPING-IMPLEMENTATION-BRIEF.md`) are implemented on `feat/org-scoping-foundation` and shipped to PR #1 (not merged). Gate green: `typecheck` ✅, `lint` ✅, `test:migrations` 21/21 ✅, and all touched-domain tests pass.

## What was built

An **Organization** layer above projects: every project belongs to exactly one organization, and each organization owns its own integration credentials and provider configuration. The Phase-1 data migration lands all pre-existing data under a default **Personal** organization with integrations still connected (idempotent, safe to re-run).

| Phase | Area | Summary |
|---|---|---|
| 1–3 | Foundation | `organizations` + `organization_settings` tables, `projects.organizationId`, migration 0016 + data migration, `organizations` domain/RPC, renderer org store + switcher + project grouping. |
| 4 | Issue trackers + GitLab/Forgejo | Per-org credential caches (`Map<orgId>`), `orgScopedSecretKey` secrets, per-org KV for Jira/GitLab/Forgejo. The issues controller resolves the org from the **project** for issue listing and threads the **active** org for connection status. |
| 5 | GitHub multi-account | `GitHubApiAuthContext` carries `organizationId` (→ `getToken` → octokit cache → PR sync). Per-org account registry (`github-account-token:<orgId>:<accountId>`, KV `githubAccounts:<orgId>`). Operations resolve the project's org; account management uses the active org; startup reconciliation files accounts under Personal. |
| 6 | Provider settings | `OverrideSettings` is per-org, backed by `organization_settings`; agent spawn resolves provider config via the conversation's project org. App-level UI settings (theme/terminal) stay global. |
| 7 | MCP | New `mcp_servers` table (migration 0017) is the per-org source of truth; `McpService` materializes the active org's servers onto agent config files with per-agent provenance (never clobbering user-added servers); on-disk servers are imported into Personal once. |
| 8 | Per-org UI + wiring | Integration/settings/MCP UIs follow the active org; org switch/create/delete + bootstrap re-materialize MCP. |

A final adversarial multi-agent review found and fixed 3 cross-org isolation gaps: an MCP read-failure data-loss path, a missing bootstrap re-materialize, and the project settings GitHub account picker not being scoped to the project's org.

## Verification

- `pnpm run typecheck` ✅, `pnpm run lint` ✅ (one pre-existing unrelated warning), `pnpm run test:migrations` 21/21 ✅, 307 touched-domain tests pass.
- **Smoke tests:** production build (`pnpm run build`) ✅, main-process Electron boot ✅, and a full end-to-end dev-mode boot (`electron-vite dev`, isolated temp DB + temp home) ✅ — main + preload + renderer compiled and launched (4 Electron processes) with no errors.

## Deferred by design / decision

3. **OAuth-linked GitHub accounts default to the Personal organization.** The generic OAuth token flow does not carry an organization. A `ProviderTokenPayload.organizationId` seam is in place; wiring it through `rpc.account.signIn` / `linkProviderAccount` is a follow-up. The GitHub **device-flow** and **CLI-import** connect paths are fully org-aware.
4. **Moving projects between organizations is deferred** per the locked decisions — there is no `moveProjectToOrganization`.
5. **Command-palette org commands not added** (optional polish). The org switcher already provides switch / create / rename / delete.

## Cross-platform test hygiene (fixed alongside)

Some pre-existing tests hardcoded POSIX assumptions and failed on Windows (they pass on CI). These were made platform-correct:

6. **Path-separator tests** (`mcp/utils/config-paths.test.ts`, `conversations/impl/grok-theme-config.test.ts`) now build expected paths with `path.join`, so they pass on every platform.
7. **Genuinely Unix-shell-specific tests** (`agent-command` Kimi-hook injection, `conversation-provider-respawn` POSIX-shell assertions) are gated with `it.skipIf(process.platform === 'win32')` — they assert Unix shell-command output, which differs on Windows; CI (Linux/macOS) still exercises them.
8. **Formatting:** `drizzle/**` (generated migration metadata) is excluded from `oxfmt` so `format:check` no longer flags generated files, and the few outstanding source files were formatted. `pnpm run format:check` is clean.
