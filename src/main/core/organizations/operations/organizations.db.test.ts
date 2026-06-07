import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { organizations, organizationSettings, projects } from '@main/db/schema';
import { PERSONAL_ORGANIZATION_ID } from '@shared/organizations';
import { createOrganization } from './createOrganization';
import { deleteOrganization } from './deleteOrganization';
import { listOrganizations } from './listOrganizations';
import { reorderOrganizations } from './reorderOrganizations';
import { updateOrganization } from './updateOrganization';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  deleteProject: vi.fn(async (_id: string) => {}),
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

// deleteProject pulls in heavy runtime singletons; stub it so cascade deletion
// is exercised at the orchestration level without those dependencies.
vi.mock('@main/core/projects/operations/deleteProject', () => ({
  deleteProject: mocks.deleteProject,
}));

describe('organizations domain', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.deleteProject.mockClear();
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('starts with only the Personal organization', async () => {
    const orgs = await listOrganizations();
    expect(orgs).toHaveLength(1);
    expect(orgs[0].id).toBe(PERSONAL_ORGANIZATION_ID);
    expect(orgs[0].isPersonal).toBe(true);
  });

  it('creates organizations with increasing sort order', async () => {
    const a = await createOrganization({ name: '  Acme  ' });
    const b = await createOrganization({ name: 'Globex' });

    expect(a.name).toBe('Acme'); // trimmed
    expect(a.isPersonal).toBe(false);
    expect(b.sortOrder).toBeGreaterThan(a.sortOrder);

    const orgs = await listOrganizations();
    expect(orgs.map((o) => o.name)).toEqual(['Personal', 'Acme', 'Globex']);
  });

  it('rejects creating an organization with a blank name', async () => {
    await expect(createOrganization({ name: '   ' })).rejects.toThrow();
  });

  it('renames an organization and reports not_found / invalid_name', async () => {
    const org = await createOrganization({ name: 'Initech' });

    const renamed = await updateOrganization(org.id, { name: 'Initech Renamed' });
    expect(renamed.success).toBe(true);
    if (renamed.success) expect(renamed.data.name).toBe('Initech Renamed');

    const missing = await updateOrganization('does-not-exist', { name: 'X' });
    expect(missing.success).toBe(false);
    if (!missing.success) expect(missing.error.type).toBe('not_found');

    const blank = await updateOrganization(org.id, { name: '  ' });
    expect(blank.success).toBe(false);
    if (!blank.success) expect(blank.error.type).toBe('invalid_name');
  });

  it('reorders organizations by the provided id order', async () => {
    const a = await createOrganization({ name: 'A' });
    const b = await createOrganization({ name: 'B' });

    await reorderOrganizations([b.id, a.id, PERSONAL_ORGANIZATION_ID]);

    const orgs = await listOrganizations();
    expect(orgs.map((o) => o.name)).toEqual(['B', 'A', 'Personal']);
  });

  it('never deletes the Personal organization', async () => {
    const result = await deleteOrganization(PERSONAL_ORGANIZATION_ID);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.type).toBe('is_personal');
  });

  it('reports not_found when deleting an unknown organization', async () => {
    const result = await deleteOrganization('nope');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.type).toBe('not_found');
  });

  it('blocks deleting a non-empty organization unless cascade is set', async () => {
    const org = await createOrganization({ name: 'Has Projects' });
    await fixture.db.insert(projects).values([
      { id: 'p1', organizationId: org.id, name: 'p1', path: '/repo/p1' },
      { id: 'p2', organizationId: org.id, name: 'p2', path: '/repo/p2' },
    ]);

    const blocked = await deleteOrganization(org.id);
    expect(blocked.success).toBe(false);
    if (!blocked.success) {
      expect(blocked.error.type).toBe('not_empty');
      if (blocked.error.type === 'not_empty') expect(blocked.error.projectCount).toBe(2);
    }
    expect(mocks.deleteProject).not.toHaveBeenCalled();

    const cascaded = await deleteOrganization(org.id, { cascade: true });
    expect(cascaded.success).toBe(true);
    expect(mocks.deleteProject).toHaveBeenCalledTimes(2);

    const remaining = await fixture.db.select().from(organizations);
    expect(remaining.map((o) => o.id)).not.toContain(org.id);
  });

  it('removes org-scoped settings when an organization is deleted', async () => {
    const org = await createOrganization({ name: 'With Settings' });
    await fixture.db
      .insert(organizationSettings)
      .values({ organizationId: org.id, key: 'providerConfigs', value: '{}' });

    const result = await deleteOrganization(org.id);
    expect(result.success).toBe(true);

    const settings = await fixture.db.select().from(organizationSettings);
    expect(settings.filter((s) => s.organizationId === org.id)).toHaveLength(0);
  });
});
