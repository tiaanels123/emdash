# MCP

## Main Files

- `src/main/core/mcp/services/McpService.ts`
- `src/main/core/mcp/services/mcp-store.ts` — org-scoped `mcp_servers` persistence and provenance
- `src/main/core/mcp/utils/` — adapters, catalog, config IO, config paths, conversion
- `src/main/core/mcp/controller.ts`
- `src/shared/mcp/`
- `src/renderer/features/mcp/`

## Current Behavior

- MCP servers are scoped per organization: the `mcp_servers` table is the source of truth, keyed by `organizationId`
- the active organization's servers are materialized onto each agent's on-disk config (per the server's provider selection); switching organizations re-materializes via `rpc.mcp.materialize`
- per-agent provenance tracks emdash-managed servers so re-materialization strips only those and never clobbers servers the user added by hand
- provider-specific config formats are handled through adapters in `src/main/core/mcp/utils/`
- the renderer MCP UI manages the active organization's installed servers and catalog entries

## Important Constraint

- Codex currently supports stdio MCP servers only

## Rules

- do not assume all providers support the same MCP transport types
- keep canonical MCP data in shared types and adapt at the edges
- if you add provider-specific MCP behavior, update both service and UI compatibility handling
