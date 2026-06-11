import { createRPCController } from '@shared/lib/ipc/rpc';
import { trelloConnectionService } from './trello-connection-service';

export const trelloController = createRPCController({
  saveCredentials: async (
    organizationId: string,
    input: { apiKey: string; token: string; boardUrls: string }
  ) => {
    if (
      !input?.apiKey ||
      typeof input.apiKey !== 'string' ||
      !input?.token ||
      typeof input.token !== 'string' ||
      typeof input.boardUrls !== 'string'
    ) {
      return { success: false, error: 'A Trello API key, token, and board URLs are required.' };
    }
    return trelloConnectionService.saveCredentials(organizationId, input);
  },

  checkConnection: async (organizationId: string) =>
    trelloConnectionService.checkConnection(organizationId),

  clearCredentials: async (organizationId: string) =>
    trelloConnectionService.clearCredentials(organizationId),
});
