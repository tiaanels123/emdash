# Renderer

## Main Entry Points

- `src/renderer/main.tsx`: boot entry — mounts `App.tsx` into `index.html` and runs bootstrap (loads stores, restores view-state snapshots).
- `src/renderer/App.tsx`: top-level provider composition.
- `src/renderer/lib/ipc.ts`: typed RPC client (`rpc`) and event emitter (`events`) used throughout the renderer.

## Application Shell (`src/renderer/app/`)

- `workspace.tsx`, `home-view.tsx`, `welcome.tsx` — top-level views.
- `view-registry.ts` — central registry of views and navigation guards.
- `modal-registry.ts` — central registry of all modals.
- `app-menu-events.tsx` — native application-menu event wiring.

## Feature Modules (`src/renderer/features/`)

Each module owns its UI and, where relevant, its stores and selectors:

- `projects` — project management, settings panel, add-project, PR view, branch selector.
- `tasks` — task experience: conversations, diff viewer, Monaco editor, terminals, PR selector.
- `organizations` — organization store (`OrganizationManagerStore`), selectors (`getActiveOrganizationId`, `useActiveOrganizationId`), organization switcher, and organization modal. The active organization scopes projects and per-org integration/MCP/provider-settings UIs.
- `sidebar` — app sidebar (hosts the organization switcher; groups projects by the active organization).
- `integrations` — issue-tracker / git-host connect/disconnect/status UI (per-organization credentials).
- `settings` — settings pages (including per-org integrations, GitHub accounts, and provider settings).
- `mcp` — MCP server management for the active organization.
- `automations`, `command-palette`, `library`, `onboarding`, `skills` — supporting feature modules.

## Shared Renderer Infrastructure (`src/renderer/lib/`)

- `ipc.ts` — typed `rpc` client and `events` emitter (the single entry point to the engine).
- `stores/` — MobX domain stores, accessed via selectors/hooks with readiness modeled explicitly.
- `query-client.ts` + cache-invalidation helpers — TanStack Query setup and coordination.
- `commands/` — the command registry powering the command palette.
- `ui/`, `components/`, `layout/`, `theme/` — UI primitives, composites, layout, and theming.
- `modal/` — modal infrastructure.
- `pty/` — renderer-side xterm/PTY integration.
- `monaco/`, `editor/` — code/diff editor integration.
- `providers/`, `hooks/` — React context providers and shared hooks.

## When Editing Here

- Check `agents/conventions/renderer-patterns.md` for modal, view, store, PTY-frontend, and context patterns.
- Call RPC methods via the typed `rpc` client from `src/renderer/lib/ipc.ts` (e.g., `rpc.tasks.create(...)`); subscribe to streaming data via the typed `events` emitter.
- New modals must be registered in `src/renderer/app/modal-registry.ts`.
- New views must be registered in `src/renderer/app/view-registry.ts`.
- New commands use `src/renderer/lib/commands/registry.ts`.
- Keep renderer↔main calls on typed RPC/events; the preload bridge (`window.electronAPI`) stays small and is added to only when a browser/Electron primitive cannot fit the RPC/event path.
