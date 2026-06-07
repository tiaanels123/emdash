import { createRPCController } from '@shared/lib/ipc/rpc';
import { plainConnectionService } from './plain-connection-service';

export const plainController = createRPCController({
  saveToken: async (organizationId: string, token: string) => {
    if (!token || typeof token !== 'string') {
      return { success: false, error: 'A Plain API key is required.' };
    }
    return plainConnectionService.saveToken(organizationId, token);
  },

  checkConnection: async (organizationId: string) =>
    plainConnectionService.checkConnection(organizationId),

  clearToken: async (organizationId: string) => plainConnectionService.clearToken(organizationId),
});
