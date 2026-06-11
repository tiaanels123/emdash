import { observer } from 'mobx-react-lite';
import { useCallback, useState } from 'react';
import {
  getProjectManagerStore,
  mountedProjectData,
} from '@renderer/features/projects/stores/project-selectors';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import type { LocalProject } from '@shared/projects';

export type AdditionalReposState = {
  selectedProjectIds: string[];
  toggle: (projectId: string) => void;
};

export function useAdditionalReposState(): AdditionalReposState {
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const toggle = useCallback((projectId: string) => {
    setSelectedProjectIds((prev) =>
      prev.includes(projectId) ? prev.filter((id) => id !== projectId) : [...prev, projectId]
    );
  }, []);
  return { selectedProjectIds, toggle };
}

/**
 * Other mounted LOCAL projects in the primary project's organization. Multi-repo
 * tasks are local-only in v1 (the agent session reaches extra repos via
 * --add-dir on one machine), so SSH projects are excluded — as is a non-local
 * primary (returns []).
 */
export function eligibleAdditionalProjects(
  primaryProjectId: string | undefined
): LocalProject[] {
  if (!primaryProjectId) return [];
  const manager = getProjectManagerStore();
  const primary = mountedProjectData(manager.projects.get(primaryProjectId));
  if (!primary || primary.type !== 'local') return [];

  return Array.from(manager.projects.values())
    .map((store) => mountedProjectData(store))
    .filter(
      (data): data is LocalProject =>
        data !== null &&
        data.type === 'local' &&
        data.id !== primaryProjectId &&
        data.organizationId === primary.organizationId
    );
}

export const AdditionalReposSection = observer(function AdditionalReposSection({
  primaryProjectId,
  state,
}: {
  primaryProjectId: string | undefined;
  state: AdditionalReposState;
}) {
  const eligible = eligibleAdditionalProjects(primaryProjectId);
  if (eligible.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm font-medium">Additional repositories</div>
      <p className="text-xs text-muted-foreground">
        The agent works across every selected repository in one session, each in its own worktree.
      </p>
      <div className="flex flex-col gap-1.5">
        {eligible.map((project) => (
          <label key={project.id} className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox
              checked={state.selectedProjectIds.includes(project.id)}
              onCheckedChange={() => state.toggle(project.id)}
            />
            <span className="truncate">{project.name}</span>
          </label>
        ))}
      </div>
    </div>
  );
});
