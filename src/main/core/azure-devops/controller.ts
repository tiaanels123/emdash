import { createRPCController } from '@shared/lib/ipc/rpc';
import { azureDevOpsConnectionService } from './azure-devops-connection-service';

export const azureDevOpsController = createRPCController({
  saveCredentials: async (
    organizationId: string,
    args: { organization: string; pat: string; project?: string }
  ) => {
    const organization = String(args?.organization || '').trim();
    const pat = String(args?.pat || '').trim();
    const project = String(args?.project || '').trim();
    if (!organization || !pat) {
      return { success: false, error: 'Organization and personal access token are required.' };
    }

    return azureDevOpsConnectionService.saveCredentials(
      organizationId,
      organization,
      pat,
      project || undefined
    );
  },

  clearCredentials: async (organizationId: string) =>
    azureDevOpsConnectionService.clearCredentials(organizationId),

  checkConnection: async (organizationId: string) =>
    azureDevOpsConnectionService.checkConnection(organizationId),
});
