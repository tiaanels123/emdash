import { log } from '@main/lib/logger';
import type { McpLoadAllResponse, McpServer, ServerMap } from '@shared/core/mcp/types';
import { PERSONAL_ORGANIZATION_ID } from '@shared/organizations';
import { adaptForward, adaptReverse } from '../utils/adapters';
import { loadCatalog } from '../utils/catalog';
import { readServers, writeServers } from '../utils/config-io';
import { getAgentMcpMeta, getAllMcpAgentIds } from '../utils/config-paths';
import { mcpServerToRaw, rawEntryToMcpFields, rawToMcpServer } from '../utils/conversion';
import {
  deleteOrgServer,
  isMcpImported,
  listOrgServers,
  markMcpImported,
  readMcpProvenance,
  upsertOrgServer,
  writeMcpProvenance,
} from './mcp-store';

/**
 * Org-scoped MCP server management.
 *
 * The emdash `mcp_servers` table is the source of truth: each organization owns
 * its own set of servers. Because the agent CLIs only read a single set of
 * global home-dir config files, the active organization's servers are
 * "materialized" onto disk — written into each agent's config (per the server's
 * provider selection) while the previously-materialized organization's
 * emdash-managed servers are stripped. Servers the user added to an agent config
 * by hand are never touched (tracked via per-agent provenance).
 */
export class McpService {
  private _writeLock = Promise.resolve();

  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this._writeLock;
    let resolve: () => void;
    this._writeLock = new Promise<void>((r) => {
      resolve = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      resolve!();
    }
  }

  async loadAll(organizationId: string): Promise<McpLoadAllResponse> {
    return this.withWriteLock(async () => {
      await this._ensureImported();
      const installed = await listOrgServers(organizationId);
      const catalog = loadCatalog();
      return { installed, catalog };
    });
  }

  async saveServer(organizationId: string, server: McpServer): Promise<void> {
    if (!server.name || !/^[\w\-._]+$/.test(server.name)) {
      throw new Error(`Invalid server name: "${server.name}"`);
    }
    return this.withWriteLock(async () => {
      await this._ensureImported();
      await upsertOrgServer(organizationId, server);
      await this._materialize(organizationId);
    });
  }

  async removeServer(organizationId: string, serverName: string): Promise<void> {
    return this.withWriteLock(async () => {
      await this._ensureImported();
      await deleteOrgServer(organizationId, serverName);
      await this._materialize(organizationId);
    });
  }

  /**
   * Writes the given organization's servers to disk (and strips the previously
   * materialized organization's emdash-managed servers). Called on organization
   * switch so the agents see the active organization's MCP servers.
   */
  async materializeOrganization(organizationId: string): Promise<void> {
    return this.withWriteLock(async () => {
      await this._ensureImported();
      await this._materialize(organizationId);
    });
  }

  private async _materialize(organizationId: string): Promise<void> {
    const servers = await listOrgServers(organizationId);
    const provenance = await readMcpProvenance();
    const nextProvenance: Record<string, string[]> = {};

    for (const agentId of getAllMcpAgentIds()) {
      const meta = getAgentMcpMeta(agentId);
      if (!meta) continue;

      let existing: ServerMap;
      try {
        existing = await readServers(meta);
      } catch (err) {
        // A transient read failure (e.g. a file lock) must NOT fall through to
        // the write below — writeServers replaces the entire servers block, so
        // writing a reset/empty map would wipe servers the user added by hand.
        // Skip this agent and keep its prior provenance.
        log.error(
          `Failed to read MCP config for ${agentId}; skipping to avoid clobbering user servers:`,
          err
        );
        nextProvenance[agentId] = provenance[agentId] ?? [];
        continue;
      }

      const writtenNames: string[] = [];
      for (const server of servers) {
        if (!server.providers.includes(agentId)) continue;
        const adapted = adaptForward(meta.adapter, { [server.name]: mcpServerToRaw(server) });
        const adaptedEntry = adapted[server.name];
        if (adaptedEntry) {
          existing[server.name] = adaptedEntry;
          writtenNames.push(server.name);
        }
      }

      // Remove emdash-managed servers from the previous materialization that the
      // active organization no longer provides. User-added entries (never in
      // provenance) are left untouched.
      const writtenSet = new Set(writtenNames);
      for (const prevName of provenance[agentId] ?? []) {
        if (!writtenSet.has(prevName) && prevName in existing) {
          delete existing[prevName];
        }
      }

      try {
        await writeServers(meta, existing);
        nextProvenance[agentId] = writtenNames;
      } catch (err) {
        log.error(`Failed to materialize MCP config for ${agentId}:`, err);
        // Disk unchanged on failure — keep the prior provenance for this agent.
        nextProvenance[agentId] = provenance[agentId] ?? [];
      }
    }

    await writeMcpProvenance(nextProvenance);
  }

  /**
   * One-time import of pre-existing on-disk MCP servers into the Personal
   * organization, so nothing is lost when the source of truth moves to the DB.
   * Idempotent (gated by a KV version key). Records the imported names as
   * provenance so they are correctly stripped when switching to another org.
   */
  private async _ensureImported(): Promise<void> {
    if (await isMcpImported()) return;

    const onDisk = await this._readOnDiskServers();
    for (const server of onDisk) {
      await upsertOrgServer(PERSONAL_ORGANIZATION_ID, server);
    }

    const provenance: Record<string, string[]> = {};
    for (const agentId of getAllMcpAgentIds()) {
      provenance[agentId] = onDisk
        .filter((server) => server.providers.includes(agentId))
        .map((server) => server.name);
    }
    await writeMcpProvenance(provenance);
    await markMcpImported();
  }

  /** Reads and merges the servers currently present in every agent's config. */
  private async _readOnDiskServers(): Promise<McpServer[]> {
    const agentIds = getAllMcpAgentIds();
    const serversByName = new Map<string, { server: McpServer; providers: Set<string> }>();

    for (const agentId of agentIds) {
      const meta = getAgentMcpMeta(agentId);
      if (!meta) continue;

      let rawServers: ServerMap;
      try {
        rawServers = await readServers(meta);
      } catch (err) {
        log.warn(`Failed to read MCP config for ${agentId}:`, err);
        continue;
      }

      const canonical = adaptReverse(meta.adapter, rawServers);

      for (const [name, raw] of Object.entries(canonical)) {
        const existing = serversByName.get(name);
        if (existing) {
          existing.providers.add(agentId);

          const newServer = rawToMcpServer(name, raw, existing.providers);
          const existingKeyCount = Object.keys(rawEntryToMcpFields(existing.server)).length;
          const newKeyCount = Object.keys(rawEntryToMcpFields(newServer)).length;
          if (newKeyCount > existingKeyCount) {
            existing.server = newServer;
          }
        } else {
          const providers = new Set([agentId]);
          serversByName.set(name, {
            server: rawToMcpServer(name, raw, providers),
            providers,
          });
        }
      }
    }

    const result: McpServer[] = [];
    for (const { server, providers } of serversByName.values()) {
      server.providers = Array.from(providers);
      result.push(server);
    }
    return result;
  }
}

export const mcpService = new McpService();
