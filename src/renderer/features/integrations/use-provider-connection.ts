import { useMutation } from '@tanstack/react-query';
import { useCallback } from 'react';

type ConnectionMutationResult = { success?: boolean; error?: string } | null | undefined;

type UseProviderConnectionOptions<TInput> = {
  organizationId: string;
  connectMutationFn: (organizationId: string, input: TInput) => Promise<ConnectionMutationResult>;
  disconnectMutationFn: (organizationId: string) => Promise<unknown>;
  invalidate: () => void;
  fallbackError: string;
  validateInput?: (input: TInput) => string | null;
};

export function useProviderConnection<TInput>({
  organizationId,
  connectMutationFn,
  disconnectMutationFn,
  invalidate,
  fallbackError,
  validateInput,
}: UseProviderConnectionOptions<TInput>) {
  const connectMutation = useMutation({
    mutationFn: (input: TInput) => connectMutationFn(organizationId, input),
    onSettled: invalidate,
  });

  const disconnectMutation = useMutation({
    mutationFn: () => disconnectMutationFn(organizationId),
    onSettled: invalidate,
  });

  const connect = useCallback(
    async (input: TInput) => {
      const validationError = validateInput?.(input);
      if (validationError) {
        throw new Error(validationError);
      }

      const result = await connectMutation.mutateAsync(input);
      if (!result?.success) {
        throw new Error(result?.error || fallbackError);
      }
    },
    [connectMutation, fallbackError, validateInput]
  );

  const disconnect = useCallback(async () => {
    await disconnectMutation.mutateAsync();
  }, [disconnectMutation]);

  return {
    connect,
    disconnect,
    isLoading: connectMutation.isPending || disconnectMutation.isPending,
  };
}
