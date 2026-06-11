import { beforeEach, describe, expect, it, vi } from 'vitest';
import { azureDevOpsConnectionService } from './azure-devops-connection-service';
import { doAdoGet, doAdoPost } from './azure-devops-http-client';
import {
  azureDevOpsIssueProvider,
  buildListWiql,
  buildSearchWiql,
} from './azure-devops-issue-provider';

vi.mock('./azure-devops-connection-service', () => ({
  azureDevOpsConnectionService: {
    requireAuth: vi.fn(),
    checkConnection: vi.fn(),
  },
}));

vi.mock('./azure-devops-http-client', () => ({
  doAdoGet: vi.fn(),
  doAdoPost: vi.fn(),
}));

const mockRequireAuth = vi.mocked(azureDevOpsConnectionService.requireAuth);
const mockDoAdoGet = vi.mocked(doAdoGet);
const mockDoAdoPost = vi.mocked(doAdoPost);

function workItem(id: number, title = `Item ${id}`, project = 'Qala') {
  return {
    id,
    fields: {
      'System.Title': title,
      'System.State': 'Active',
      'System.WorkItemType': 'User Story',
      'System.TeamProject': project,
      'System.ChangedDate': '2026-05-30T12:00:00Z',
      'System.AssignedTo': { displayName: 'Jona' },
    },
  };
}

describe('azureDevOpsIssueProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAuth.mockResolvedValue({
      baseUrl: 'https://dev.azure.com/qala',
      organization: 'qala',
      project: undefined,
      pat: 'pat',
    });
  });

  it('builds the assigned-to-me list WIQL ordered by changed date', () => {
    expect(buildListWiql()).toBe(
      'SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me ORDER BY [System.ChangedDate] DESC'
    );
  });

  it('builds search WIQL for numeric ids and free text (escaping quotes)', () => {
    expect(buildSearchWiql('1234')).toBe(
      'SELECT [System.Id] FROM WorkItems WHERE [System.Id] = 1234'
    );
    expect(buildSearchWiql("Tom's bug")).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE [System.Title] CONTAINS 'Tom''s bug' ORDER BY [System.ChangedDate] DESC"
    );
  });

  it('lists work items via WIQL then hydration, preserving the WIQL order', async () => {
    mockDoAdoPost.mockResolvedValue(JSON.stringify({ workItems: [{ id: 2 }, { id: 1 }] }));
    // The batch endpoint does not guarantee order; return them reversed.
    mockDoAdoGet.mockResolvedValue(JSON.stringify({ value: [workItem(1), workItem(2)] }));

    const result = await azureDevOpsIssueProvider.listIssues({ organizationId: 'org' });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.issues.map((issue) => issue.identifier)).toEqual(['2', '1']);
    expect(result.issues[0]).toMatchObject({
      provider: 'azuredevops',
      identifier: '2',
      title: 'Item 2',
      url: 'https://dev.azure.com/qala/Qala/_workitems/edit/2',
      status: 'Active',
      assignees: ['Jona'],
      project: 'Qala',
      updatedAt: '2026-05-30T12:00:00Z',
    });
  });

  it('returns an empty list (and skips hydration) when WIQL yields nothing', async () => {
    mockDoAdoPost.mockResolvedValue(JSON.stringify({ workItems: [] }));

    const result = await azureDevOpsIssueProvider.listIssues({ organizationId: 'org' });

    expect(result).toEqual({ success: true, issues: [] });
    expect(mockDoAdoGet).not.toHaveBeenCalled();
  });

  it('scopes the WIQL request to the configured project when present', async () => {
    mockRequireAuth.mockResolvedValue({
      baseUrl: 'https://dev.azure.com/qala',
      organization: 'qala',
      project: 'Qala',
      pat: 'pat',
    });
    mockDoAdoPost.mockResolvedValue(JSON.stringify({ workItems: [] }));

    await azureDevOpsIssueProvider.listIssues({ organizationId: 'org' });

    expect(String(mockDoAdoPost.mock.calls[0]?.[0])).toContain('/qala/Qala/_apis/wit/wiql');
  });

  it('searches by id via WIQL', async () => {
    mockDoAdoPost.mockResolvedValue(JSON.stringify({ workItems: [{ id: 42 }] }));
    mockDoAdoGet.mockResolvedValue(JSON.stringify({ value: [workItem(42)] }));

    const result = await azureDevOpsIssueProvider.searchIssues({
      organizationId: 'org',
      searchTerm: '42',
    });

    expect(result.success).toBe(true);
    const body = JSON.parse(String(mockDoAdoPost.mock.calls[0]?.[2] || '{}')) as { query?: string };
    expect(body.query).toBe('SELECT [System.Id] FROM WorkItems WHERE [System.Id] = 42');
  });

  it('returns failure when credentials are missing', async () => {
    mockRequireAuth.mockRejectedValue(new Error('Azure DevOps credentials not set.'));

    const result = await azureDevOpsIssueProvider.listIssues({ organizationId: 'org' });

    expect(result).toEqual({ success: false, error: 'Azure DevOps credentials not set.' });
  });
});
