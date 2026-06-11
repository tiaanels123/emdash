import { Building2, ChevronsUpDown, Pencil, Plus, Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback } from 'react';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { cn } from '@renderer/utils/utils';
import type { Organization } from '@shared/organizations';
import { getOrganizationManagerStore } from '../stores/organization-selectors';

export const OrganizationSwitcher = observer(function OrganizationSwitcher() {
  const store = getOrganizationManagerStore();
  const showOrgModal = useShowModal('organizationModal');
  const showConfirm = useShowModal('confirmActionModal');

  const active = store.activeOrganization;
  const organizations = store.organizations;

  const handleDelete = useCallback(
    (org: Organization) => {
      void (async () => {
        const result = await store.deleteOrganization(org.id);
        if (result.success || result.error.type !== 'not_empty') return;
        const count = result.error.projectCount;
        showConfirm({
          title: `Delete ${org.name}?`,
          description: `This organization has ${count} project${count === 1 ? '' : 's'}. Deleting it permanently removes ${
            count === 1 ? 'that project' : 'those projects'
          } and all their worktrees and conversations.`,
          confirmLabel: 'Delete organization and projects',
          onSuccess: () => {
            void store.deleteOrganization(org.id, { cascade: true });
          },
        });
      })();
    },
    [store, showConfirm]
  );

  if (!active) return null;

  return (
    <div className="px-2.5 pt-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="Switch organization"
              className={cn(
                'flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-sm text-foreground hover:bg-background-hover'
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Building2 className="size-4 shrink-0 text-foreground-muted" />
                <span className="truncate font-medium">{active.name}</span>
              </span>
              <ChevronsUpDown className="size-3.5 shrink-0 text-foreground-muted" />
            </button>
          }
        />
        <DropdownMenuContent className="min-w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Organizations</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={active.id}>
              {organizations.map((org) => (
                <DropdownMenuRadioItem
                  key={org.id}
                  value={org.id}
                  onClick={() => store.setActiveOrganization(org.id)}
                >
                  {org.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => showOrgModal({ mode: 'create' })}>
            <Plus className="size-4" />
            New organization
          </DropdownMenuItem>
          {!active.isPersonal && (
            <>
              <DropdownMenuItem
                onClick={() =>
                  showOrgModal({
                    mode: 'rename',
                    organizationId: active.id,
                    currentName: active.name,
                  })
                }
              >
                <Pencil className="size-4" />
                Rename organization
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => handleDelete(active)}
              >
                <Trash2 className="size-4" />
                Delete organization
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
});
