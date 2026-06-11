import type { LinkedIssue } from '@shared/core/linked-issue';
import type {
  ConnectionStatus,
  IssueContextResult,
  IssueListResult,
  IssueProviderCapabilities,
} from '@shared/issue-providers';

export type IssueQueryOpts = {
  limit?: number;
  /**
   * The organization whose integration credentials should be used. For the
   * issue read paths (list/search/context) this is resolved from the project
   * by the issues controller; callers do not set it directly.
   */
  organizationId?: string;
  projectId?: string;
  projectPath?: string;
  remote?: string;
  repositoryUrl?: string;
};

export type IssueSearchOpts = IssueQueryOpts & {
  searchTerm: string;
};

export type IssueContextOpts = IssueQueryOpts & {
  identifier: string;
};

export interface IssueProvider {
  readonly type: LinkedIssue['provider'];
  readonly capabilities: IssueProviderCapabilities;

  checkConnection(organizationId: string): Promise<ConnectionStatus>;
  listIssues(opts: IssueQueryOpts): Promise<IssueListResult>;
  searchIssues(opts: IssueSearchOpts): Promise<IssueListResult>;
  getIssueContext?(opts: IssueContextOpts): Promise<IssueContextResult>;
}
