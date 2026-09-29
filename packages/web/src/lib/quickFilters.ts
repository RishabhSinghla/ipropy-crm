import type { FilterGroup } from '@ipropy/shared';
import type { DispositionPick } from '../components/CallDispositionFilter';
import type { TaskQueue } from '../components/FollowUpQueue';

function conditionCount(filter: FilterGroup): number {
  return filter.conditions.reduce((total, node) => (
    total + ('conditions' in node ? conditionCount(node) : 1)
  ), 0);
}

export function countActiveQuickFilters({ filter, stages, agent, task, disposition, types }: {
  filter: FilterGroup;
  stages: string[];
  agent: string | null;
  task: TaskQueue | null;
  disposition: DispositionPick;
  types: string[];
}): number {
  return conditionCount(filter)
    + stages.length
    + (agent ? 1 : 0)
    + (task ? 1 : 0)
    + disposition.outcomes.length
    + (disposition.never ? 1 : 0)
    + types.length;
}
