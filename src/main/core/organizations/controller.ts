import { createRPCController } from '@shared/lib/ipc/rpc';
import { createOrganization } from './operations/createOrganization';
import { deleteOrganization } from './operations/deleteOrganization';
import { getOrganization } from './operations/getOrganization';
import { listOrganizations } from './operations/listOrganizations';
import { reorderOrganizations } from './operations/reorderOrganizations';
import { updateOrganization } from './operations/updateOrganization';

export const organizationsController = createRPCController({
  createOrganization,
  listOrganizations,
  getOrganization,
  updateOrganization,
  deleteOrganization,
  reorderOrganizations,
});
