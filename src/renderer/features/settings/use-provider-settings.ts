import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useActiveOrganizationId } from '@renderer/features/organizations/stores/organization-selectors';
import { rpc } from '@renderer/lib/ipc';
import type { ProviderCustomConfig } from '@shared/core/app-settings';

type ProviderSettingsMeta = {
  value: ProviderCustomConfig;
  defaults: ProviderCustomConfig;
  overrides: Partial<ProviderCustomConfig>;
} | null;

export function useProviderSettings(providerId: string) {
  const queryClient = useQueryClient();
  const organizationId = useActiveOrganizationId();

  const metaQueryKey = ['providerSettings', organizationId, providerId, 'meta'] as const;
  const allQueryKey = ['providerSettings', organizationId, 'all'] as const;

  const { data, isLoading } = useQuery<ProviderSettingsMeta>({
    queryKey: metaQueryKey,
    queryFn: () =>
      rpc.providerSettings.getItemWithMeta(
        organizationId,
        providerId
      ) as Promise<ProviderSettingsMeta>,
    staleTime: 60_000,
  });

  const updateMutation = useMutation<void, Error, Partial<ProviderCustomConfig>>({
    mutationFn: (config) =>
      rpc.providerSettings.updateItem(organizationId, providerId, config) as Promise<void>,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: metaQueryKey });
      void queryClient.invalidateQueries({ queryKey: allQueryKey });
    },
  });

  const resetMutation = useMutation<void, Error, void>({
    mutationFn: () => rpc.providerSettings.resetItem(organizationId, providerId) as Promise<void>,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: metaQueryKey });
      void queryClient.invalidateQueries({ queryKey: allQueryKey });
    },
  });

  return {
    value: data?.value,
    defaults: data?.defaults,
    overrides: data?.overrides,
    isLoading,
    isSaving: updateMutation.isPending || resetMutation.isPending,
    isOverridden: !!(data?.overrides && Object.keys(data.overrides).length > 0),
    isFieldOverridden: (field: keyof ProviderCustomConfig) =>
      !!(data?.overrides && field in data.overrides),
    update: updateMutation.mutate,
    reset: resetMutation.mutate,
  };
}
