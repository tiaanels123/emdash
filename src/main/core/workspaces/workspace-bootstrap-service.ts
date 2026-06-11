import path from 'node:path';
import { and, asc, eq, sql } from 'drizzle-orm';
import { projectManager } from '@main/core/projects/project-manager';
import type { ProjectProvider, TaskProvider } from '@main/core/projects/project-provider';
import { sshConnectionManager } from '@main/core/ssh/lifecycle/production-ssh-connection-manager';
import { buildTaskFromWorkspace, emitTaskProvisionProgress } from '@main/core/tasks/task-builder';
import { mapTaskRowToTask } from '@main/core/tasks/utils/utils';
import { db as appDb, type AppDb } from '@main/db/client';
import { taskProjects, tasks, workspaces } from '@main/db/schema';
import { log } from '@main/lib/logger';
import type { Branch } from '@shared/core/git/git';
import type { Task, ProvisionWorkspaceError } from '@shared/core/tasks/tasks';
import type { WorkspaceConfig } from '@shared/core/workspaces/workspace-config';
import type { WorkspaceProviderData } from '@shared/core/workspaces/workspace-provider-data';
import { compileSetupSpec } from '@shared/core/workspaces/workspace-setup-spec';
import type { WorkspaceType } from '@shared/core/workspaces/workspaces';
import { err, ok, type Result } from '@shared/lib/result';
import { deriveBranchName, resolveWorkspaceIntent } from '../tasks/resolve-workspace-intent';
import { provisionBYOITask } from './byoi/provision-byoi-task';
import { LocalWorkspaceSetupExecutor } from './local-workspace-setup-executor';
import { applyRecovery } from './recovery-strategy';
import { createWorkspaceFactory } from './workspace-factory';
import { computeWorkspaceKey } from './workspace-key';
import { workspaceRegistry } from './workspace-registry';

export type WorkspaceBootstrapResult = {
  path: string;
  workspaceId: string;
  sshConnectionId?: string;
  worktreeGitDir?: string;
  taskProvider: TaskProvider;
  /** BYOI only — workspace provider data to persist in the DB. */
  workspaceProviderData?: WorkspaceProviderData;
  /** Provisioned workspaces of the task's additional repos (multi-repo tasks). */
  additionalWorkspaces?: AdditionalWorkspaceResult[];
};

export type AdditionalWorkspaceResult = {
  projectId: string;
  workspaceId: string;
  path: string;
  worktreeGitDir?: string;
  branchName?: string;
};

type ResolvedWorkspacePath = {
  path: string;
  /** May differ from the input row id when persistPath deduped onto an existing row. */
  workspaceId: string;
  branchName?: string;
  sourceBranch?: Branch;
};

export class WorkspaceBootstrapService {
  constructor(private readonly db: AppDb) {}

  /**
   * Ensures the workspace for a task is fully set up on disk, acquires the
   * workspace (running lifecycle scripts), and builds task providers.
   *
   * - **Fast path (idempotent)**: if `workspaceRow.path` is set and the directory
   *   exists on disk, skips git setup and goes straight to workspace acquisition.
   * - **BYOI workspaces**: delegates to `provisionBYOITask` which runs the
   *   provision script, connects SSH, and acquires the workspace.
   * - **Local/SSH workspaces**: compiles and executes the `WorkspaceSetupSpec`,
   *   applies recovery on failure, persists the resolved path, then acquires.
   * - **SSH channel recovery**: calls `reportChannelRecovered` after a successful
   *   setup on an SSH project.
   */
  async ensureWorkspaceSetup(
    workspaceRow: {
      id: string;
      type: WorkspaceType;
      kind?: string | null;
      path: string | null;
      config?: WorkspaceConfig | null;
      branchName?: string | null;
      workspaceProvider?: string | null;
      data?: WorkspaceProviderData | null;
    },
    taskRow: {
      workspaceIntent: string | null;
      workspaceProvider: string | null;
    },
    task: Task,
    project: ProjectProvider,
    opts?: { extraWorktreePaths?: string[] }
  ): Promise<Result<WorkspaceBootstrapResult, ProvisionWorkspaceError>> {
    // BYOI workspaces are managed by provisionBYOITask.
    if (workspaceRow.kind === 'byoi' || workspaceRow.type === 'byoi') {
      return this._provisionBYOI(workspaceRow, task, project);
    }

    const resolved = await this._resolveWorkspacePath(workspaceRow, taskRow, project);
    if (!resolved.success) return resolved;

    return this._acquireAndBuild(
      workspaceRow.id,
      task,
      project,
      resolved.data.path,
      resolved.data.branchName,
      resolved.data.sourceBranch,
      opts?.extraWorktreePaths
    );
  }

  /**
   * Resolves the on-disk path for a non-BYOI workspace: project-root and
   * already-on-disk fast paths, otherwise compiles and executes the
   * `WorkspaceSetupSpec` (with recovery) and persists the resolved path.
   */
  private async _resolveWorkspacePath(
    workspaceRow: {
      id: string;
      type: WorkspaceType;
      kind?: string | null;
      path: string | null;
      config?: WorkspaceConfig | null;
      branchName?: string | null;
    },
    taskRow: {
      workspaceIntent: string | null;
      workspaceProvider: string | null;
    },
    project: ProjectProvider
  ): Promise<Result<ResolvedWorkspacePath, ProvisionWorkspaceError>> {
    // Derive branch info from workspace config for passing to task providers.
    const wsConfig = workspaceRow.config;
    const workspaceBranchName: string | undefined =
      workspaceRow.branchName ??
      (wsConfig ? (deriveBranchName(wsConfig.git) ?? undefined) : undefined);
    const workspaceSourceBranch: Branch | undefined =
      wsConfig?.git.kind === 'create-branch' ? wsConfig.git.fromBranch : undefined;

    // project-root fast-path: use the project repo path directly.
    // Path is set by ensureRepositoryWorkspace at mount time.
    if (workspaceRow.kind === 'project-root') {
      return ok({
        path: workspaceRow.path ?? project.repoPath,
        workspaceId: workspaceRow.id,
        branchName: workspaceBranchName,
        sourceBranch: workspaceSourceBranch,
      });
    }

    // Fast path: path already persisted and still exists on disk.
    if (workspaceRow.path) {
      const exists = await project.worktreeHost.existsAbsolute(workspaceRow.path);
      if (exists) {
        return ok({
          path: workspaceRow.path,
          workspaceId: workspaceRow.id,
          branchName: workspaceBranchName,
          sourceBranch: workspaceSourceBranch,
        });
      }
    }

    const intent = resolveWorkspaceIntent(taskRow, workspaceRow);
    if (!intent) {
      return err({ type: 'no-intent' });
    }

    const connectionId =
      project.defaultWorkspaceType.kind === 'ssh'
        ? project.defaultWorkspaceType.connectionId
        : undefined;

    const { baseRemote, pushRemote } = await project.repository.getConfiguredRemotes();
    const spec = compileSetupSpec(intent.git, intent.workspace, { baseRemote, pushRemote });

    const intentBranchName = deriveBranchName(intent.git) ?? undefined;
    const intentSourceBranch: Branch | undefined =
      intent.git.kind === 'create-branch' ? intent.git.fromBranch : undefined;

    if (spec.length === 0) {
      // No git operations needed — use existing project root or provided path.
      const resolvedPath =
        'path' in intent.workspace && intent.workspace.path
          ? intent.workspace.path
          : project.repoPath;
      const persistedId = await this.persistPath(
        workspaceRow.id,
        resolvedPath,
        workspaceRow.type,
        connectionId,
        intentBranchName
      );
      return ok({
        path: resolvedPath,
        workspaceId: persistedId,
        branchName: intentBranchName,
        sourceBranch: intentSourceBranch,
      });
    }

    const worktreePoolPath = await project.worktreeService.getWorktreePoolPath();
    const stepCtx = {
      ctx: project.ctx,
      repoPath: project.repoPath,
      worktreePoolPath,
      host: project.worktreeHost,
      projectSettings: project.settings,
    };

    const executor = new LocalWorkspaceSetupExecutor(stepCtx);
    let setupResult = await executor.execute(spec);

    if (!setupResult.success) {
      const recovery = await applyRecovery(setupResult.error, stepCtx);

      if (recovery.kind === 'resolved') {
        setupResult = ok({ path: recovery.path, warnings: [] });
      } else if (recovery.kind === 'retry') {
        setupResult = await executor.execute(spec);
      }
      // 'failed' falls through to the error check below
    }

    if (!setupResult.success) {
      const { kind, type } = setupResult.error;
      const message = 'message' in setupResult.error ? setupResult.error.message : undefined;
      return err({ type: 'setup-failed', stepKind: kind, stepErrorType: type, message });
    }

    const resolvedPath = setupResult.data.path;
    let persistedId = workspaceRow.id;
    if (resolvedPath) {
      persistedId = await this.persistPath(
        workspaceRow.id,
        resolvedPath,
        workspaceRow.type,
        connectionId,
        intentBranchName
      );
    }

    if (connectionId) {
      sshConnectionManager.reportChannelRecovered(connectionId);
    }

    return ok({
      path: resolvedPath ?? '',
      workspaceId: persistedId,
      branchName: intentBranchName,
      sourceBranch: intentSourceBranch,
    });
  }

  /**
   * Provisions one ADDITIONAL repo of a multi-repo task: resolves/creates the
   * worktree and acquires the workspace (running lifecycle scripts), but does
   * NOT build task providers — those are built once, from the primary
   * workspace, with the additional worktree paths passed along.
   */
  async ensureAdditionalWorkspaceSetup(
    workspaceRow: {
      id: string;
      type: WorkspaceType;
      kind?: string | null;
      path: string | null;
      config?: WorkspaceConfig | null;
      branchName?: string | null;
    },
    taskRow: {
      workspaceIntent: string | null;
      workspaceProvider: string | null;
    },
    task: Task,
    project: ProjectProvider
  ): Promise<Result<AdditionalWorkspaceResult, ProvisionWorkspaceError>> {
    const resolved = await this._resolveWorkspacePath(workspaceRow, taskRow, project);
    if (!resolved.success) return resolved;
    const workspaceId = resolved.data.workspaceId;

    emitTaskProvisionProgress({
      taskId: task.id,
      projectId: project.projectId,
      step: 'initialising-workspace',
      message: 'Initialising workspace…',
    });

    let workspace;
    try {
      workspace = await workspaceRegistry.acquire(
        workspaceId,
        project.projectId,
        createWorkspaceFactory(workspaceId, project.defaultWorkspaceType, {
          task,
          workDir: resolved.data.path,
          projectId: project.projectId,
          projectPath: project.repoPath,
          settings: project.settings,
          logPrefix: 'WorkspaceBootstrapService',
          repository: project.repository,
          fetchService: project.gitFetchService,
        })
      );
    } catch (e) {
      return err({
        type: 'setup-failed',
        stepKind: 'workspace-acquire',
        stepErrorType: 'error',
        message: String(e),
      });
    }

    let worktreeGitDir: string | undefined;
    if (project.defaultWorkspaceType.kind === 'local') {
      try {
        const mainDotGitAbs = path.resolve(project.repoPath, '.git');
        worktreeGitDir = await workspace.git.getWorktreeGitDir(mainDotGitAbs);
      } catch (e) {
        log.warn('WorkspaceBootstrapService: failed to resolve worktreeGitDir', {
          workspaceId,
          error: String(e),
        });
      }
    }

    return ok({
      projectId: project.projectId,
      workspaceId,
      path: resolved.data.path,
      worktreeGitDir,
      branchName: resolved.data.branchName,
    });
  }

  /**
   * Public entry point for the RPC controller.
   * Loads the workspace + task rows from DB, resolves the project,
   * and delegates to `ensureWorkspaceSetup`.
   */
  async ensureWorkspaceSetupForTask(
    taskId: string
  ): Promise<Result<WorkspaceBootstrapResult, ProvisionWorkspaceError>> {
    const [row] = await this.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!row?.workspaceId) throw new Error(`Task ${taskId} has no workspaceId`);

    const [wsRow] = await this.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, row.workspaceId))
      .limit(1);
    if (!wsRow) throw new Error(`Workspace ${row.workspaceId} not found for task ${taskId}`);

    const project = projectManager.getProject(row.projectId);
    if (!project) throw new Error(`Project ${row.projectId} not found`);

    const task = mapTaskRowToTask(row);

    // Provision the additional repos FIRST so their worktree paths can be
    // baked into the primary workspace's task providers (agent --add-dir).
    const attachments = await this.db
      .select()
      .from(taskProjects)
      .where(eq(taskProjects.taskId, taskId))
      .orderBy(asc(taskProjects.sortOrder));
    const secondary = attachments.filter((a) => a.projectId !== row.projectId);

    const additionalWorkspaces: AdditionalWorkspaceResult[] = [];
    const releaseProvisioned = async () => {
      await Promise.all(
        additionalWorkspaces.map((a) =>
          workspaceRegistry.release(a.workspaceId, 'terminate').catch(() => {})
        )
      );
    };

    for (const attachment of secondary) {
      const repoProject = projectManager.getProject(attachment.projectId);
      if (!repoProject || !attachment.workspaceId) {
        await releaseProvisioned();
        return err({
          type: 'setup-failed',
          stepKind: 'attached-repo',
          stepErrorType: 'project-not-available',
          message: `Attached project ${attachment.projectId} is not available`,
        });
      }

      const [repoWsRow] = await this.db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, attachment.workspaceId))
        .limit(1);
      if (!repoWsRow) {
        await releaseProvisioned();
        return err({
          type: 'setup-failed',
          stepKind: 'attached-repo',
          stepErrorType: 'workspace-not-found',
          message: `Workspace ${attachment.workspaceId} not found for attached project ${attachment.projectId}`,
        });
      }

      const result = await this.ensureAdditionalWorkspaceSetup(repoWsRow, row, task, repoProject);
      if (!result.success) {
        await releaseProvisioned();
        return result;
      }

      // persistPath may have deduped onto an existing workspace row — keep the
      // attachment row pointing at the row that actually owns the path.
      if (result.data.workspaceId !== attachment.workspaceId) {
        await this.db
          .update(taskProjects)
          .set({ workspaceId: result.data.workspaceId })
          .where(
            and(eq(taskProjects.taskId, taskId), eq(taskProjects.projectId, attachment.projectId))
          );
      }
      additionalWorkspaces.push(result.data);
    }

    const primary = await this.ensureWorkspaceSetup(wsRow, row, task, project, {
      extraWorktreePaths: additionalWorkspaces.map((a) => a.path),
    });
    if (!primary.success) {
      await releaseProvisioned();
      return primary;
    }

    return ok({ ...primary.data, additionalWorkspaces });
  }

  /**
   * Persists a resolved path (and its derived key) onto a workspace row.
   *
   * If another workspace already owns that path (same key), its ID is returned
   * so the caller can re-point any tasks. Returns the original workspaceId when
   * the update succeeds normally.
   *
   * @internal Exposed for unit testing; prefer `ensureWorkspaceSetup` in application code.
   */
  async persistPath(
    workspaceId: string,
    path: string,
    type: WorkspaceType,
    connectionId?: string,
    branchName?: string
  ): Promise<string> {
    const key = type !== 'byoi' ? computeWorkspaceKey(type, path, connectionId) : null;

    if (key) {
      const [existing] = await this.db.select().from(workspaces).where(eq(workspaces.key, key));
      if (existing && existing.id !== workspaceId) {
        return existing.id;
      }
    }

    await this.db
      .update(workspaces)
      .set({ path, key, branchName: branchName ?? null, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(workspaces.id, workspaceId));
    return workspaceId;
  }

  /**
   * Acquires the workspace via the registry (runs lifecycle scripts on first
   * acquire) then builds task providers. Returns a `WorkspaceBootstrapResult`.
   */
  private async _acquireAndBuild(
    workspaceId: string,
    task: Task,
    project: ProjectProvider,
    workDir: string,
    workspaceBranchName?: string,
    workspaceSourceBranch?: Branch,
    extraWorktreePaths?: string[]
  ): Promise<Result<WorkspaceBootstrapResult, ProvisionWorkspaceError>> {
    const type = project.defaultWorkspaceType;

    emitTaskProvisionProgress({
      taskId: task.id,
      projectId: project.projectId,
      step: 'initialising-workspace',
      message: 'Initialising workspace…',
    });

    let workspace;
    try {
      workspace = await workspaceRegistry.acquire(
        workspaceId,
        project.projectId,
        createWorkspaceFactory(workspaceId, type, {
          task,
          workDir,
          projectId: project.projectId,
          projectPath: project.repoPath,
          settings: project.settings,
          logPrefix: 'WorkspaceBootstrapService',
          repository: project.repository,
          fetchService: project.gitFetchService,
        })
      );
    } catch (e) {
      return err({
        type: 'setup-failed',
        stepKind: 'workspace-acquire',
        stepErrorType: 'error',
        message: String(e),
      });
    }

    // Compute worktreeGitDir for local workspaces (used by git watcher registry).
    let worktreeGitDir: string | undefined;
    if (type.kind === 'local') {
      try {
        const mainDotGitAbs = path.resolve(project.repoPath, '.git');
        worktreeGitDir = await workspace.git.getWorktreeGitDir(mainDotGitAbs);
      } catch (e) {
        log.warn('WorkspaceBootstrapService: failed to resolve worktreeGitDir', {
          workspaceId,
          error: String(e),
        });
      }
    }

    emitTaskProvisionProgress({
      taskId: task.id,
      projectId: project.projectId,
      step: 'starting-sessions',
      message: 'Preparing task…',
    });

    let buildSucceeded = false;
    try {
      const buildResult = await buildTaskFromWorkspace(
        task,
        workspace,
        type,
        project.projectId,
        project.repoPath,
        project.settings,
        workspaceBranchName,
        workspaceSourceBranch,
        extraWorktreePaths
      );
      buildSucceeded = true;
      return ok({
        path: workDir,
        workspaceId,
        sshConnectionId: type.kind === 'ssh' ? type.connectionId : undefined,
        worktreeGitDir,
        taskProvider: buildResult.taskProvider,
      });
    } catch (e) {
      return err({
        type: 'setup-failed',
        stepKind: 'build-providers',
        stepErrorType: 'error',
        message: String(e),
      });
    } finally {
      if (!buildSucceeded) {
        await workspaceRegistry.release(workspaceId, 'terminate').catch(() => {});
      }
    }
  }

  /**
   * Provisions a BYOI workspace by delegating to `provisionBYOITask`.
   */
  private async _provisionBYOI(
    workspaceRow: {
      id: string;
      workspaceProvider?: string | null;
      data?: WorkspaceProviderData | null;
    },
    task: Task,
    project: ProjectProvider
  ): Promise<Result<WorkspaceBootstrapResult, ProvisionWorkspaceError>> {
    const projectSettings = await project.settings.get();
    if (projectSettings.workspaceProvider?.type !== 'script') {
      return err({
        type: 'setup-failed',
        stepKind: 'byoi-config',
        stepErrorType: 'missing-provider',
        message: 'Task has workspaceProvider=byoi but project has no script provider configured',
      });
    }

    try {
      const result = await provisionBYOITask({
        task,
        wpConfig: projectSettings.workspaceProvider,
        ctx: project.ctx,
        projectId: project.projectId,
        projectPath: project.repoPath,
        settings: project.settings,
        logPrefix: `${project.type}ProjectProvider[byoi]`,
        workspaceId: workspaceRow.id,
      });
      return ok(result);
    } catch (e) {
      return err({
        type: 'setup-failed',
        stepKind: 'byoi-provision',
        stepErrorType: 'error',
        message: String(e),
      });
    }
  }
}

export const workspaceBootstrapService = new WorkspaceBootstrapService(appDb);
