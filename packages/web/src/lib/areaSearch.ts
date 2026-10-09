import type { FieldMeta, FilterCondition, FilterGroup } from '@ipropy/shared';

/** Compare square-yard input against the stored unit, without changing data. */
export function areaSearchRange(field: FieldMeta, companion: FieldMeta | undefined, min?: number, max?: number): FilterGroup | undefined {
  if (min === undefined && max === undefined) return undefined;
  const bounds = (factor = 9): FilterCondition[] => [
    ...(min === undefined ? [] : [{ field: field.name, operator: 'greater_or_equal' as const, value: min * 9 / factor }]),
    ...(max === undefined ? [] : [{ field: field.name, operator: 'less_or_equal' as const, value: max * 9 / factor }]),
  ];
  if (!companion) return { logic: 'AND', conditions: bounds() };
  const branches: FilterGroup[] = [];
  for (const unit of field.config.unitOptions ?? []) {
    if (!unit.factorSqft || unit.factorSqft <= 0) continue;
    const match: FilterGroup = { logic: 'OR', conditions: [{ field: companion.name, operator: 'equals', value: unit.value }] };
    // Blank historical units retain the field's original fallback, not the new default.
    if (unit.value === companion.defaultValue) match.conditions.push({ field: companion.name, operator: 'is_empty' });
    branches.push({ logic: 'AND', conditions: [match, ...bounds(unit.factorSqft)] });
  }
  // An empty OR is interpreted as unrestricted by the query builder. With no
  // known conversion, return no matches instead of silently ignoring the range.
  return branches.length ? { logic: 'OR', conditions: branches } : {
    logic: 'AND', conditions: [
      { field: field.name, operator: 'is_empty' },
      { field: field.name, operator: 'is_not_empty' },
    ],
  };
}
