import { localDependencyManager } from '@main/core/dependencies/dependency-manager';
import { log } from '@main/lib/logger';
import { AGENT_PROVIDERS } from '@shared/core/agents/agent-provider-registry';
import type { DependencyId } from '@shared/core/dependencies';
import type { McpProvidersResponse, McpServer } from '@shared/core/mcp/types';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { mcpService } from './services/McpService';
import { agentSupportsHttp, getAllMcpAgentIds } from './utils/config-paths';

function mapProviders(agentIds: string[]): McpProvidersResponse[] {
  return agentIds.map((id) => {
    const provider = AGENT_PROVIDERS.find((p) => p.id === id);
    const dep = localDependencyManager.get(id as DependencyId);
    return {
      id,
      name: provider?.name ?? id,
      installed: dep?.status === 'available',
      supportsHttp: agentSupportsHttp(id),
    };
  });
}

export const mcpController = createRPCController({
  loadAll: async (organizationId: string) => {
    try {
      const data = await mcpService.loadAll(organizationId);
      return { success: true, data };
    } catch (error) {
      log.error('Failed to load MCP servers:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  saveServer: async (organizationId: string, server: McpServer) => {
    try {
      await mcpService.saveServer(organizationId, server);
      return { success: true };
    } catch (error) {
      log.error('Failed to save MCP server:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  removeServer: async (organizationId: string, serverName: string) => {
    try {
      await mcpService.removeServer(organizationId, serverName);
      return { success: true };
    } catch (error) {
      log.error('Failed to remove MCP server:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  materialize: async (organizationId: string) => {
    try {
      await mcpService.materializeOrganization(organizationId);
      return { success: true };
    } catch (error) {
      log.error('Failed to materialize MCP servers:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  getProviders: async () => {
    try {
      return { success: true, data: mapProviders(getAllMcpAgentIds()) };
    } catch (error) {
      log.error('Failed to get MCP providers:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  refreshProviders: async () => {
    try {
      await localDependencyManager.probeCategory('agent');
      return { success: true, data: mapProviders(getAllMcpAgentIds()) };
    } catch (error) {
      log.error('Failed to refresh MCP providers:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
});
