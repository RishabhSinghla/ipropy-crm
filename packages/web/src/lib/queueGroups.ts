import type { FilterGroup, ListResult, ModuleMeta } from '@ipropy/shared';

/** Grouping is presentation metadata, never a unique constraint on records. */
export function queueGroupField(module: Pick<ModuleMeta, 'settings' | 'fields'>): string | undefined {
  const name = module.settings?.queueGroupBy;
  return typeof name === 'string' && module.fields.some((field) => field.name === name && field.isActive)
    ? name : undefined;
}

export function populatedQueueGroups(groups: ListResult['groups']) {
  return (groups ?? []).filter((group) => group.count > 0)
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}

export function queueGroupFilter(field: string, key: string, existing?: FilterGroup): FilterGroup {
  return { logic: 'AND', conditions: [
    ...(existing ? [existing] : []),
    { field, operator: key === '' ? 'is_empty' : 'equals', ...(key === '' ? {} : { value: key }) },
  ] };
}
