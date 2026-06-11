import { createRPCController } from '@shared/lib/ipc/rpc';
import { asanaConnectionService } from './asana-connection-service';

export const asanaController = createRPCController({
  saveToken: async (organizationId: string, token: string) => {
    if (!token || typeof token !== 'string') {
      return { success: false, error: 'An Asana access token is required.' };
    }
    return asanaConnectionService.saveToken(organizationId, token);
  },

  checkConnection: async (organizationId: string) =>
    asanaConnectionService.checkConnection(organizationId),

  clearToken: async (organizationId: string) => asanaConnectionService.clearToken(organizationId),
});
