import { createRPCController } from '@shared/lib/ipc/rpc';
import { featurebaseConnectionService } from './featurebase-connection-service';

export const featurebaseController = createRPCController({
  saveToken: async (organizationId: string, token: string) => {
    if (!token || typeof token !== 'string') {
      return { success: false, error: 'A Featurebase API key is required.' };
    }
    return featurebaseConnectionService.saveToken(organizationId, token);
  },

  checkConnection: async (organizationId: string) =>
    featurebaseConnectionService.checkConnection(organizationId),

  clearToken: async (organizationId: string) =>
    featurebaseConnectionService.clearToken(organizationId),
});
