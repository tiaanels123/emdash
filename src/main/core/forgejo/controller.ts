import { createRPCController } from '@shared/lib/ipc/rpc';
import { forgejoConnectionService } from './forgejo-connection-service';

export const forgejoController = createRPCController({
  saveCredentials: async (
    organizationId: string,
    creds: { instanceUrl: string; token: string }
  ) => {
    if (!creds.instanceUrl || !creds.token) {
      return { success: false, error: 'Instance URL and API token are required.' };
    }
    return forgejoConnectionService.saveCredentials(organizationId, creds.instanceUrl, creds.token);
  },

  clearCredentials: async (organizationId: string) =>
    forgejoConnectionService.clearCredentials(organizationId),

  checkConnection: async (organizationId: string) =>
    forgejoConnectionService.checkConnection(organizationId),
});
