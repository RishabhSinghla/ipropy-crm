import type { FilterCondition } from '@ipropy/shared';

export function dashboardChoiceCondition(field: string, value: string): FilterCondition {
  if (value === '__blank') return { field, operator: 'is_empty' };
  if (field === 'record_tags') return { field, operator: 'has_any', value: [value] };
  return { field, operator: 'equals', value };
}
