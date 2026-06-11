import { createRPCController } from '@shared/lib/ipc/rpc';
import { gitLabConnectionService } from './gitlab-connection-service';

export const gitlabController = createRPCController({
  saveCredentials: async (
    organizationId: string,
    creds: { instanceUrl: string; token: string }
  ) => {
    if (!creds.instanceUrl || !creds.token) {
      return { success: false, error: 'Instance URL and API token are required.' };
    }
    return gitLabConnectionService.saveCredentials(organizationId, creds.instanceUrl, creds.token);
  },

  clearCredentials: async (organizationId: string) =>
    gitLabConnectionService.clearCredentials(organizationId),

  checkConnection: async (organizationId: string) =>
    gitLabConnectionService.checkConnection(organizationId),
});
