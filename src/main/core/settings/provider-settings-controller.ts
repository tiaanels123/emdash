import type { ProviderCustomConfig } from '@shared/core/app-settings';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { providerOverrideSettings } from './provider-settings-service';

export const providerSettingsController = createRPCController({
  getAll: (organizationId: string): Promise<Record<string, ProviderCustomConfig>> =>
    providerOverrideSettings.getAll(organizationId),

  getItem: (organizationId: string, id: string): Promise<ProviderCustomConfig | undefined> =>
    providerOverrideSettings.getItem(organizationId, id),

  getItemWithMeta: (
    organizationId: string,
    id: string
  ): Promise<{
    value: ProviderCustomConfig;
    defaults: ProviderCustomConfig;
    overrides: Partial<ProviderCustomConfig>;
  } | null> => providerOverrideSettings.getItemWithMeta(organizationId, id),

  updateItem: (
    organizationId: string,
    id: string,
    config: Partial<ProviderCustomConfig>
  ): Promise<void> => providerOverrideSettings.updateItem(organizationId, id, config),

  resetItem: (organizationId: string, id: string): Promise<void> =>
    providerOverrideSettings.resetItem(organizationId, id),

  resetAll: (organizationId: string): Promise<void> =>
    providerOverrideSettings.resetAll(organizationId),
});
