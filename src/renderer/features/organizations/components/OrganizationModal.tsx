import { observer } from 'mobx-react-lite';
import { useCallback, useState } from 'react';
import { getOrganizationManagerStore } from '@renderer/features/organizations/stores/organization-selectors';
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';

const MAX_ORGANIZATION_NAME_LENGTH = 60;

type OrganizationModalArgs = {
  mode: 'create' | 'rename';
  /** Required when mode is 'rename'. */
  organizationId?: string;
  /** The current name, used to seed the input when renaming. */
  currentName?: string;
};

type Props = BaseModalProps<void> & OrganizationModalArgs;

export const OrganizationModal = observer(function OrganizationModal({
  mode,
  organizationId,
  currentName,
  onSuccess,
  onClose,
}: Props) {
  const store = getOrganizationManagerStore();
  const [name, setName] = useState(mode === 'rename' ? (currentName ?? '') : '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const isEmpty = trimmed.length === 0;
  const isUnchanged = mode === 'rename' && trimmed === currentName;
  const isValid = !isEmpty && !isUnchanged;

  const handleSubmit = useCallback(async () => {
    if (!isValid) return;
    setIsSubmitting(true);
    setError(null);
    try {
      if (mode === 'create') {
        await store.createOrganization({ name: trimmed });
        onSuccess();
        return;
      }
      if (!organizationId) {
        setError('Missing organization.');
        setIsSubmitting(false);
        return;
      }
      const result = await store.updateOrganization(organizationId, { name: trimmed });
      if (!result.success) {
        setError(result.error.message ?? 'Failed to rename organization.');
        setIsSubmitting(false);
        return;
      }
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save organization');
      setIsSubmitting(false);
    }
  }, [isValid, mode, organizationId, store, trimmed, onSuccess]);

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>{mode === 'create' ? 'New organization' : 'Rename organization'}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        <FieldGroup>
          <Field>
            <FieldLabel>Organization name</FieldLabel>
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSubmit();
              }}
              maxLength={MAX_ORGANIZATION_NAME_LENGTH}
              placeholder="e.g. Acme Inc."
              autoFocus
            />
            {error && <p className="text-destructive mt-1 text-xs">{error}</p>}
          </Field>
        </FieldGroup>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <ConfirmButton onClick={() => void handleSubmit()} disabled={!isValid || isSubmitting}>
          {isSubmitting
            ? mode === 'create'
              ? 'Creating...'
              : 'Renaming...'
            : mode === 'create'
              ? 'Create'
              : 'Rename'}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
});
