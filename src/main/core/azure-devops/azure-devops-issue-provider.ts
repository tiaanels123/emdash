import { URL } from 'node:url';
import { clampIssueLimit, normalizeSearchTerm } from '@main/core/issues/helpers/provider-inputs';
import type { IssueProvider } from '@main/core/issues/issue-provider';
import type { LinkedIssue } from '@shared/core/linked-issue';
import { ISSUE_PROVIDER_CAPABILITIES, type IssueListResult } from '@shared/issue-providers';
import { PERSONAL_ORGANIZATION_ID } from '@shared/organizations';
import { azureDevOpsConnectionService } from './azure-devops-connection-service';
import { doAdoGet, doAdoPost } from './azure-devops-http-client';

const API_VERSION = '7.1';
// `GET _apis/wit/workitems` accepts at most 200 ids per request.
const HYDRATE_BATCH_SIZE = 200;
const WORK_ITEM_FIELDS = [
  'System.Id',
  'System.Title',
  'System.State',
  'System.WorkItemType',
  'System.TeamProject',
  'System.ChangedDate',
  'System.AssignedTo',
];

interface WiqlResult {
  workItems?: Array<{ id?: number }>;
}

interface RawWorkItemFields {
  'System.Title'?: string;
  'System.State'?: string;
  'System.WorkItemType'?: string;
  'System.TeamProject'?: string;
  'System.ChangedDate'?: string;
  'System.AssignedTo'?: { displayName?: string; uniqueName?: string } | string | null;
}

interface RawWorkItem {
  id?: number;
  fields?: RawWorkItemFields;
}

interface WorkItemsBatchResult {
  value?: RawWorkItem[];
}

type Auth = Awaited<ReturnType<typeof azureDevOpsConnectionService.requireAuth>>;

export function buildListWiql(): string {
  return 'SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me ORDER BY [System.ChangedDate] DESC';
}

export function buildSearchWiql(searchTerm: string): string {
  const term = normalizeSearchTerm(searchTerm);
  if (/^\d+$/.test(term)) {
    return `SELECT [System.Id] FROM WorkItems WHERE [System.Id] = ${Number(term)}`;
  }
  const escaped = term.replace(/'/g, "''");
  return `SELECT [System.Id] FROM WorkItems WHERE [System.Title] CONTAINS '${escaped}' ORDER BY [System.ChangedDate] DESC`;
}

// Scope the WIQL query to the configured project when present; otherwise run it
// org-wide across all projects in the organization.
function wiqlUrl(auth: Auth, limit: number): URL {
  const projectSegment = auth.project ? `/${encodeURIComponent(auth.project)}` : '';
  const url = new URL(`${auth.baseUrl}${projectSegment}/_apis/wit/wiql?api-version=${API_VERSION}`);
  url.searchParams.set('$top', String(limit));
  return url;
}

async function queryWorkItemIds(auth: Auth, wiql: string, limit: number): Promise<number[]> {
  const body = await doAdoPost(wiqlUrl(auth, limit), auth.pat, JSON.stringify({ query: wiql }));
  const data = JSON.parse(body || '{}') as WiqlResult;
  const ids = (data.workItems ?? [])
    .map((item) => item?.id)
    .filter((id): id is number => typeof id === 'number');
  return ids.slice(0, limit);
}

async function hydrateWorkItems(auth: Auth, ids: number[]): Promise<RawWorkItem[]> {
  const items: RawWorkItem[] = [];
  for (let i = 0; i < ids.length; i += HYDRATE_BATCH_SIZE) {
    const chunk = ids.slice(i, i + HYDRATE_BATCH_SIZE);
    const url = new URL(`${auth.baseUrl}/_apis/wit/workitems?api-version=${API_VERSION}`);
    url.searchParams.set('ids', chunk.join(','));
    url.searchParams.set('fields', WORK_ITEM_FIELDS.join(','));
    const body = await doAdoGet(url, auth.pat);
    const data = JSON.parse(body || '{}') as WorkItemsBatchResult;
    if (Array.isArray(data.value)) {
      items.push(...data.value);
    }
  }
  return items;
}

function assigneeName(value: RawWorkItemFields['System.AssignedTo']): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return value || undefined;
  return value.displayName || value.uniqueName || undefined;
}

function normalize(baseUrl: string, items: RawWorkItem[], idOrder: number[]): LinkedIssue[] {
  const base = baseUrl.replace(/\/$/, '');
  const byId = new Map<number, RawWorkItem>();
  for (const item of items) {
    if (typeof item?.id === 'number') {
      byId.set(item.id, item);
    }
  }

  // The workitems batch endpoint does not guarantee order, so re-apply the WIQL order.
  const ordered = idOrder
    .map((id) => byId.get(id))
    .filter((item): item is RawWorkItem => Boolean(item));

  return ordered.map((item) => {
    const fields = item.fields ?? {};
    const project = fields['System.TeamProject'];
    const id = String(item.id ?? '');
    const url = project
      ? `${base}/${encodeURIComponent(project)}/_workitems/edit/${id}`
      : `${base}/_workitems/edit/${id}`;
    const assignee = assigneeName(fields['System.AssignedTo']);
    return {
      provider: 'azuredevops',
      identifier: id,
      title: String(fields['System.Title'] || ''),
      url,
      status: fields['System.State'] || undefined,
      assignees: assignee ? [assignee] : undefined,
      project: project || undefined,
      updatedAt: fields['System.ChangedDate'] || undefined,
      fetchedAt: new Date().toISOString(),
    } satisfies LinkedIssue;
  });
}

async function fetchIssues(auth: Auth, wiql: string, limit: number): Promise<LinkedIssue[]> {
  const ids = await queryWorkItemIds(auth, wiql, limit);
  if (ids.length === 0) return [];
  const items = await hydrateWorkItems(auth, ids);
  return normalize(auth.baseUrl, items, ids);
}

async function listIssues(organizationId: string, limit: number): Promise<IssueListResult> {
  try {
    const auth = await azureDevOpsConnectionService.requireAuth(organizationId);
    const issues = await fetchIssues(auth, buildListWiql(), clampIssueLimit(limit, 50, 200));
    return { success: true, issues };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function searchIssues(
  organizationId: string,
  searchTerm: string,
  limit: number
): Promise<IssueListResult> {
  const term = normalizeSearchTerm(searchTerm);
  if (!term) {
    return { success: true, issues: [] };
  }

  try {
    const auth = await azureDevOpsConnectionService.requireAuth(organizationId);
    const issues = await fetchIssues(auth, buildSearchWiql(term), clampIssueLimit(limit, 20, 200));
    return { success: true, issues };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export const azureDevOpsIssueProvider: IssueProvider = {
  type: 'azuredevops',
  capabilities: ISSUE_PROVIDER_CAPABILITIES.azuredevops,

  checkConnection: (organizationId) => azureDevOpsConnectionService.checkConnection(organizationId),

  listIssues: async (opts) =>
    listIssues(opts.organizationId ?? PERSONAL_ORGANIZATION_ID, opts.limit ?? 50),

  searchIssues: async (opts) =>
    searchIssues(
      opts.organizationId ?? PERSONAL_ORGANIZATION_ID,
      opts.searchTerm,
      opts.limit ?? 20
    ),
};
