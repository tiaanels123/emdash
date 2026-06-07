import { createRPCController } from '@shared/lib/ipc/rpc';
import { mondayConnectionService } from './monday-connection-service';

export const mondayController = createRPCController({
  saveCredentials: async (organizationId: string, input: { token: string; boardUrls: string }) => {
    if (!input?.token || typeof input.token !== 'string') {
      return { success: false, error: 'A Monday.com API token is required.' };
    }
    return mondayConnectionService.saveCredentials(organizationId, input);
  },

  checkConnection: async (organizationId: string) =>
    mondayConnectionService.checkConnection(organizationId),

  clearCredentials: async (organizationId: string) =>
    mondayConnectionService.clearCredentials(organizationId),
});
