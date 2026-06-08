import { listProjectsForOrganization } from '@main/core/projects/operations/getProjects';
import { projectManager } from '@main/core/projects/project-manager';
import { log } from '@main/lib/logger';
import { projectGitHubAccountBackfillService } from './project-github-account-backfill-instance';

/**
 * Re-run the per-project GitHub account backfill for every mounted project in an
 * organization. Invoked after accounts are added to an org (CLI import or device flow)
 * so already-mounted projects pick up an account without requiring an app restart.
 *
 * Projects that already have a `githubAccountId` are left untouched — `backfillProject`
 * is a no-op for them — so this never overrides an explicit per-project selection.
 */
export async function backfillOrganizationProjectAccounts(organizationId: string): Promise<void> {
  let projectList: Awaited<ReturnType<typeof listProjectsForOrganization>>;
  try {
    projectList = await listProjectsForOrganization(organizationId);
  } catch (error) {
    log.warn('backfillOrganizationProjectAccounts: failed to list projects', {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  await Promise.allSettled(
    projectList.map(async (project) => {
      const provider = projectManager.getProject(project.id);
      if (!provider) return;
      try {
        await projectGitHubAccountBackfillService.backfillProject(provider);
      } catch (error) {
        log.warn('backfillOrganizationProjectAccounts: backfill failed for project', {
          projectId: project.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })
  );
}
