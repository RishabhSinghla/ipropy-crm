import { isFilterGroup, type FilterGroup } from '@ipropy/shared';

/** Stable AND/OR ordering lets the New shortcut reuse its prefetched list. */
export function canonicalFilter(filter: FilterGroup): FilterGroup {
  return { ...filter, conditions: filter.conditions.map(item => isFilterGroup(item) ? canonicalFilter(item) : item)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
}

export function withCreatedToday(filter: FilterGroup): FilterGroup {
  return { logic: 'AND', conditions: [
    ...(filter.logic === 'OR' && filter.conditions.length ? [filter] : filter.conditions),
    { field: 'created_at', operator: 'today' },
  ] };
}
