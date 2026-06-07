import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getActiveOrganizationId, useActiveOrganizationId } from '@renderer/features/organizations/stores/organization-selectors';
import { rpc } from '@renderer/lib/ipc';

export const GITHUB_ACCOUNTS_QUERY_KEY = ['github:accounts'] as const;
export const GITHUB_ACCOUNT_STATE_QUERY_KEY = ['github:account-state'] as const;
export const ISSUE_CONNECTION_STATUS_QUERY_KEY = ['issues:connection-status'] as const;

function invalidateGitHubAccountState(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: GITHUB_ACCOUNTS_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: GITHUB_ACCOUNT_STATE_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: ISSUE_CONNECTION_STATUS_QUERY_KEY });
}

export function useGitHubAccounts() {
  const organizationId = useActiveOrganizationId();
  return useQuery({
    queryKey: [...GITHUB_ACCOUNTS_QUERY_KEY, organizationId],
    queryFn: () => rpc.github.listAccounts(organizationId),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useImportGitHubCliAccounts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => rpc.github.importCliAccounts(getActiveOrganizationId()),
    onSuccess: () => invalidateGitHubAccountState(queryClient),
  });
}

export function useGitHubDeviceFlowAuth() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => rpc.github.auth(getActiveOrganizationId()),
    onSettled: () => invalidateGitHubAccountState(queryClient),
  });
}

export function useSetDefaultGitHubAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) =>
      rpc.github.setDefaultAccount(getActiveOrganizationId(), accountId),
    onSuccess: () => invalidateGitHubAccountState(queryClient),
  });
}

export function useRemoveGitHubAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) =>
      rpc.github.removeAccount(getActiveOrganizationId(), accountId),
    onSuccess: () => invalidateGitHubAccountState(queryClient),
  });
}
