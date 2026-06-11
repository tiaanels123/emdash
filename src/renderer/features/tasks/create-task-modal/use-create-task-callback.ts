import { useCallback } from 'react';
import {
  getRepositoryStore,
  getProjectManagerStore,
  mountedProjectData,
} from '@renderer/features/projects/stores/project-selectors';
import { useAgentAutoApproveDefaults } from '@renderer/features/tasks/hooks/useAgentAutoApproveDefaults';
import { getTaskManagerStore } from '@renderer/features/tasks/stores/task-selectors';
import type { NavigateFnTyped } from '@renderer/lib/layout/navigation-provider';
import { log } from '@renderer/utils/logger';
import type { LocalProject, SshProject } from '@shared/projects';
import type { InitialConversationState } from '../conversations/initial-conversation-section';
import {
  buildAdditionalRepoConfigs,
  buildGitSetup,
  buildInitialConversation,
  buildWorkspaceConfig,
  deriveInitialStatus,
  type AdditionalRepoInfo,
} from './build-create-task-params';
import type { CreateTaskState } from './use-create-task-state';

interface UseCreateTaskCallbackParams {
  selectedProjectId: string | undefined;
  state: CreateTaskState;
  initialConversation: InitialConversationState;
  isUnborn: boolean;
  projectData: LocalProject | SshProject | null;
  useBYOI: boolean;
  additionalProjectIds: string[];
  navigate: NavigateFnTyped;
  onClose: () => void;
}

function resolveAdditionalRepoInfos(projectIds: string[]): AdditionalRepoInfo[] {
  return projectIds.flatMap((projectId) => {
    const data = mountedProjectData(getProjectManagerStore().projects.get(projectId));
    if (!data) return [];
    return [
      {
        projectId,
        defaultBranch: getRepositoryStore(projectId)?.defaultBranch ?? null,
        repositoryWorkspaceId: data.repositoryWorkspaceId,
      },
    ];
  });
}

export function useCreateTaskCallback({
  selectedProjectId,
  state,
  initialConversation,
  isUnborn,
  projectData,
  useBYOI,
  additionalProjectIds,
  navigate,
  onClose,
}: UseCreateTaskCallbackParams): { handleCreateTask: () => void; canCreate: boolean } {
  const autoApproveDefaults = useAgentAutoApproveDefaults();
  const canCreate = !!selectedProjectId && state.isValid;

  const handleCreateTask = useCallback(() => {
    if (!selectedProjectId) return;
    const taskManager = getTaskManagerStore(selectedProjectId);
    if (!taskManager) return;

    // BYOI tasks are single-repo (v1 limit, enforced main-side too).
    const additionalRepos = useBYOI
      ? undefined
      : buildAdditionalRepoConfigs(
          buildGitSetup(state, isUnborn),
          state.branchNameState.branchName,
          resolveAdditionalRepoInfos(additionalProjectIds)
        );

    const id = crypto.randomUUID();
    void taskManager
      .createTask({
        id,
        projectId: selectedProjectId,
        taskConfig: {
          version: '1',
          name: state.taskName.effectiveTaskName,
          linkedIssue: state.linkedType === 'issue' ? (state.linkedIssue ?? undefined) : undefined,
          initialStatus: deriveInitialStatus(state.linkedType, state.linkedPR),
          initialConversation: buildInitialConversation(
            initialConversation,
            autoApproveDefaults.getDefault
          ),
        },
        workspaceConfig: buildWorkspaceConfig(state, isUnborn, projectData, useBYOI),
        ...(additionalRepos?.length ? { additionalRepos } : {}),
      })
      .catch((e) => log.error('create task failed', e));

    navigate('task', { projectId: selectedProjectId, taskId: id });
    onClose();
  }, [
    selectedProjectId,
    state,
    isUnborn,
    projectData,
    useBYOI,
    additionalProjectIds,
    initialConversation,
    autoApproveDefaults.getDefault,
    navigate,
    onClose,
  ]);

  return { handleCreateTask, canCreate };
}
