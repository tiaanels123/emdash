import { createRPCController } from '@shared/lib/ipc/rpc';
import { linearConnectionService } from './linear-connection-service';

export const linearController = createRPCController({
  saveToken: async (organizationId: string, token: string) => {
    if (!token || typeof token !== 'string') {
      return { success: false, error: 'A Linear API token is required.' };
    }
    return linearConnectionService.saveToken(organizationId, token);
  },

  checkConnection: async (organizationId: string) =>
    linearConnectionService.checkConnection(organizationId),

  clearToken: async (organizationId: string) => linearConnectionService.clearToken(organizationId),
});
