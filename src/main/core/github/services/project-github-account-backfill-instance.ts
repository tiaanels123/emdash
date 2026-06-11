import { getProjectOrganizationId } from '@main/core/projects/operations/getProjects';
import { githubAccountRegistry } from '../accounts/github-account-registry-instance';
import { ProjectGitHubAccountBackfillService } from './project-github-account-backfill';

export const projectGitHubAccountBackfillService = new ProjectGitHubAccountBackfillService(
  githubAccountRegistry,
  getProjectOrganizationId
);
