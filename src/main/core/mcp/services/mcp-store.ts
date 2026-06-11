import { and, eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { KV } from '@main/db/kv';
import { mcpServers } from '@main/db/schema';
import { log } from '@main/lib/logger';
import type { McpServer } from '@shared/core/mcp/types';

/**
 * Persistence for org-scoped MCP servers (the emdash-owned source of truth) and
 * the bookkeeping needed to materialize them safely onto disk:
 *
 * - `mcp_servers` rows: the canonical per-organization server list.
 * - `mcp` KV namespace:
 *   - `importVersion`: gates the one-time import of pre-existing on-disk servers.
 *   - `provenance`: per-agent list of server names emdash last wrote to disk, so
 *     the materialize step strips only emdash-managed servers and never clobbers
 *     servers the user added to an agent config by hand.
 */

export const MCP_IMPORT_VERSION = '1';

type McpKVSchema = {
  importVersion: string;
  provenance: Record<string, string[]>;
};

const mcpKV = new KV<McpKVSchema>('mcp');

export async function listOrgServers(organizationId: string): Promise<McpServer[]> {
  const rows = await db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.organizationId, organizationId));
  const servers: McpServer[] = [];
  for (const row of rows) {
    try {
      servers.push(JSON.parse(row.config) as McpServer);
    } catch (err) {
      log.warn(`Failed to parse stored MCP server "${row.name}":`, err);
    }
  }
  return servers;
}

export async function upsertOrgServer(organizationId: string, server: McpServer): Promise<void> {
  const config = JSON.stringify(server);
  const now = Date.now();
  await db
    .insert(mcpServers)
    .values({ organizationId, name: server.name, config, updatedAt: now })
    .onConflictDoUpdate({
      target: [mcpServers.organizationId, mcpServers.name],
      set: { config, updatedAt: now },
    });
}

export async function deleteOrgServer(organizationId: string, name: string): Promise<void> {
  await db
    .delete(mcpServers)
    .where(and(eq(mcpServers.organizationId, organizationId), eq(mcpServers.name, name)));
}

export async function isMcpImported(): Promise<boolean> {
  return (await mcpKV.get('importVersion')) === MCP_IMPORT_VERSION;
}

export async function markMcpImported(): Promise<void> {
  await mcpKV.setOrThrow('importVersion', MCP_IMPORT_VERSION);
}

export async function readMcpProvenance(): Promise<Record<string, string[]>> {
  return (await mcpKV.get('provenance')) ?? {};
}

export async function writeMcpProvenance(provenance: Record<string, string[]>): Promise<void> {
  await mcpKV.setOrThrow('provenance', provenance);
}
