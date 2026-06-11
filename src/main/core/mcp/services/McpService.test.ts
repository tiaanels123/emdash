import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMcpMeta, McpServer, ServerMap } from '@shared/core/mcp/types';
import { PERSONAL_ORGANIZATION_ID } from '@shared/organizations';
import * as configIO from '../utils/config-io';
import * as configPaths from '../utils/config-paths';
import * as store from './mcp-store';
import { McpService } from './McpService';

// In-memory backing for the org-scoped MCP store so the service can be tested
// without the database. Reset in beforeEach.
const storeState = vi.hoisted(() => ({
  servers: new Map<string, Map<string, McpServer>>(),
  provenance: {} as Record<string, string[]>,
  imported: true,
}));

vi.mock('./mcp-store', () => ({
  listOrgServers: vi.fn(async (orgId: string) =>
    Array.from((storeState.servers.get(orgId) ?? new Map<string, McpServer>()).values())
  ),
  upsertOrgServer: vi.fn(async (orgId: string, server: McpServer) => {
    let byName = storeState.servers.get(orgId);
    if (!byName) {
      byName = new Map<string, McpServer>();
      storeState.servers.set(orgId, byName);
    }
    byName.set(server.name, server);
  }),
  deleteOrgServer: vi.fn(async (orgId: string, name: string) => {
    storeState.servers.get(orgId)?.delete(name);
  }),
  isMcpImported: vi.fn(async () => storeState.imported),
  markMcpImported: vi.fn(async () => {
    storeState.imported = true;
  }),
  readMcpProvenance: vi.fn(async () => storeState.provenance),
  writeMcpProvenance: vi.fn(async (p: Record<string, string[]>) => {
    storeState.provenance = p;
  }),
}));

vi.mock('../utils/config-io', () => ({
  readServers: vi.fn(),
  writeServers: vi.fn(),
}));

vi.mock('../utils/config-paths', () => ({
  getAgentMcpMeta: vi.fn(),
  getAllMcpAgentIds: vi.fn(() => ['claude', 'cursor']),
}));

vi.mock('../utils/catalog', () => ({
  loadCatalog: vi.fn(() => []),
  getCatalogServerConfig: vi.fn(),
}));

vi.mock('@main/lib/logger', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const mockReadServers = vi.mocked(configIO.readServers);
const mockWriteServers = vi.mocked(configIO.writeServers);
const mockGetMeta = vi.mocked(configPaths.getAgentMcpMeta);
const mockUpsert = vi.mocked(store.upsertOrgServer);

const ORG = 'org-1';

const claudeMeta: AgentMcpMeta = {
  agentId: 'claude',
  configPath: '/home/test/.claude.json',
  serversPath: ['mcpServers'],
  template: { mcpServers: {} },
  isToml: false,
  adapter: 'passthrough',
};

const cursorMeta: AgentMcpMeta = {
  agentId: 'cursor',
  configPath: '/home/test/.cursor/mcp.json',
  serversPath: ['mcpServers'],
  template: { mcpServers: {} },
  isToml: false,
  adapter: 'cursor',
};

function seedOrgServer(orgId: string, server: McpServer): void {
  let byName = storeState.servers.get(orgId);
  if (!byName) {
    byName = new Map<string, McpServer>();
    storeState.servers.set(orgId, byName);
  }
  byName.set(server.name, server);
}

describe('McpService', () => {
  let service: McpService;

  beforeEach(() => {
    vi.clearAllMocks();
    storeState.servers = new Map();
    storeState.provenance = {};
    storeState.imported = true;
    service = new McpService();
    mockGetMeta.mockImplementation((id: string) => {
      if (id === 'claude') return claudeMeta;
      if (id === 'cursor') return cursorMeta;
      return undefined;
    });
    // Return a fresh object per call (production reads/parses a fresh map each
    // time); a shared object would leak one agent's in-place edits into another.
    mockReadServers.mockImplementation(async () => ({}));
    mockWriteServers.mockResolvedValue(undefined);
  });

  describe('loadAll', () => {
    it('returns the organization servers from the store', async () => {
      seedOrgServer(ORG, {
        name: 'myServer',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'foo'],
        providers: ['claude'],
      });

      const result = await service.loadAll(ORG);
      expect(result.installed).toHaveLength(1);
      expect(result.installed[0].name).toBe('myServer');
      expect(result.installed[0].providers).toContain('claude');
    });

    it('scopes results by organization', async () => {
      seedOrgServer('org-a', {
        name: 'aServer',
        transport: 'stdio',
        command: 'a',
        providers: ['claude'],
      });
      seedOrgServer('org-b', {
        name: 'bServer',
        transport: 'stdio',
        command: 'b',
        providers: ['claude'],
      });

      const a = await service.loadAll('org-a');
      const b = await service.loadAll('org-b');
      expect(a.installed.map((s) => s.name)).toEqual(['aServer']);
      expect(b.installed.map((s) => s.name)).toEqual(['bServer']);
    });
  });

  describe('saveServer', () => {
    it('persists to the store and materializes to selected providers', async () => {
      await service.saveServer(ORG, {
        name: 'myServer',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'foo'],
        providers: ['claude'],
      });

      expect(mockUpsert).toHaveBeenCalledWith(
        ORG,
        expect.objectContaining({ name: 'myServer', providers: ['claude'] })
      );
      const claudeCall = mockWriteServers.mock.calls.find((c) => c[0] === claudeMeta);
      expect(claudeCall).toBeDefined();
      expect((claudeCall![1] as ServerMap).myServer).toBeDefined();
      // Not selected for cursor -> nothing written for cursor.
      const cursorCall = mockWriteServers.mock.calls.find((c) => c[0] === cursorMeta);
      if (cursorCall) {
        expect((cursorCall[1] as ServerMap).myServer).toBeUndefined();
      }
    });

    it('rejects empty server name', async () => {
      await expect(
        service.saveServer(ORG, {
          name: '',
          transport: 'stdio',
          command: 'npx',
          providers: ['claude'],
        })
      ).rejects.toThrow('Invalid server name');
    });

    it('rejects server name with invalid characters', async () => {
      await expect(
        service.saveServer(ORG, {
          name: 'my server/hack',
          transport: 'stdio',
          command: 'npx',
          providers: ['claude'],
        })
      ).rejects.toThrow('Invalid server name');
    });
  });

  describe('removeServer', () => {
    it('deletes from the store and strips it from disk, keeping user servers', async () => {
      seedOrgServer(ORG, {
        name: 'toRemove',
        transport: 'stdio',
        command: 'npx',
        providers: ['claude'],
      });
      storeState.provenance = { claude: ['toRemove'], cursor: [] };
      mockReadServers.mockImplementation(async () => ({
        toRemove: { command: 'npx' },
        userServer: { command: 'hand-added' },
      }));

      await service.removeServer(ORG, 'toRemove');

      const claudeCall = mockWriteServers.mock.calls.find((c) => c[0] === claudeMeta);
      expect(claudeCall).toBeDefined();
      const written = claudeCall![1] as ServerMap;
      expect(written.toRemove).toBeUndefined();
      expect(written.userServer).toBeDefined();
    });
  });

  describe('materializeOrganization', () => {
    it('writes the active org servers and strips the previous org emdash servers', async () => {
      seedOrgServer(ORG, {
        name: 'serverA',
        transport: 'stdio',
        command: 'a',
        providers: ['claude'],
      });
      // Previous org had serverB materialized on disk for claude.
      storeState.provenance = { claude: ['serverB'], cursor: [] };
      mockReadServers.mockImplementation(async () => ({
        serverB: { command: 'b' },
        userServer: { command: 'hand-added' },
      }));

      await service.materializeOrganization(ORG);

      const claudeCall = mockWriteServers.mock.calls.find((c) => c[0] === claudeMeta);
      expect(claudeCall).toBeDefined();
      const written = claudeCall![1] as ServerMap;
      expect(written.serverA).toBeDefined(); // active org server added
      expect(written.serverB).toBeUndefined(); // previous org server stripped
      expect(written.userServer).toBeDefined(); // user server preserved
      expect(storeState.provenance.claude).toEqual(['serverA']);
    });

    it('skips an agent whose config cannot be read instead of clobbering it', async () => {
      seedOrgServer(ORG, {
        name: 'serverA',
        transport: 'stdio',
        command: 'a',
        providers: ['claude', 'cursor'],
      });
      storeState.provenance = { claude: ['old'], cursor: [] };
      // claude read fails (e.g. transient file lock); cursor reads fine.
      mockReadServers.mockImplementation(async (meta: AgentMcpMeta) => {
        if (meta.agentId === 'claude') throw new Error('EBUSY');
        return {};
      });

      await service.materializeOrganization(ORG);

      // claude must NOT be written (would overwrite/clobber user servers).
      expect(mockWriteServers.mock.calls.find((c) => c[0] === claudeMeta)).toBeUndefined();
      // cursor still materialized normally.
      expect(mockWriteServers.mock.calls.find((c) => c[0] === cursorMeta)).toBeDefined();
      // claude provenance preserved so a later switch can still strip correctly.
      expect(storeState.provenance.claude).toEqual(['old']);
    });
  });

  describe('first-run import', () => {
    it('imports on-disk servers into the Personal organization once', async () => {
      storeState.imported = false;
      mockReadServers.mockImplementation(async (meta: AgentMcpMeta) =>
        meta.agentId === 'claude'
          ? ({ existing: { command: 'npx', args: ['x'] } } as ServerMap)
          : ({} as ServerMap)
      );

      await service.loadAll(ORG);

      expect(mockUpsert).toHaveBeenCalledWith(
        PERSONAL_ORGANIZATION_ID,
        expect.objectContaining({ name: 'existing' })
      );
      expect(vi.mocked(store.markMcpImported)).toHaveBeenCalled();
      expect(storeState.provenance.claude).toEqual(['existing']);
    });

    it('does not re-import when already imported', async () => {
      storeState.imported = true;
      await service.loadAll(ORG);
      expect(mockUpsert).not.toHaveBeenCalled();
    });
  });
});
