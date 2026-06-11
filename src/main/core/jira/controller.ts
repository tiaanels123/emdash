import { createRPCController } from '@shared/lib/ipc/rpc';
import { jiraConnectionService } from './jira-connection-service';

export const jiraController = createRPCController({
  saveCredentials: async (
    organizationId: string,
    args: { siteUrl: string; email: string; token: string }
  ) => {
    const siteUrl = String(args?.siteUrl || '').trim();
    const email = String(args?.email || '').trim();
    const token = String(args?.token || '').trim();
    if (!siteUrl || !email || !token) {
      return { success: false, error: 'Site URL, email, and API token are required.' };
    }

    return jiraConnectionService.saveCredentials(organizationId, siteUrl, email, token);
  },

  clearCredentials: async (organizationId: string) =>
    jiraConnectionService.clearCredentials(organizationId),

  checkConnection: async (organizationId: string) =>
    jiraConnectionService.checkConnection(organizationId),
});
