/**
 * The two date chips that open a short list: **New** (when a record was added)
 * and **Visits** (when a planned visit is).
 *
 * **10 October 2026, the owner:** *"Rename Today Visits into Visits, also Build
 * Dropdown filter for today, Overdue, Upcoming, tomorrow in same Button/Chip"*
 * and, of New, *"built dropdown filter of Yesterday, This Week, This Month in
 * same Button/Chip"*.
 *
 * Each choice is one or two ordinary filter conditions on the list's own
 * filter, so the count, the rows, an export and a saved view all read the same
 * question. Kept pure so a `node` test can read it.
 */
import { type FilterCondition, type FilterGroup, isFilterGroup } from '@ipropy/shared';

export type CreatedWhen = 'today' | 'yesterday' | 'this_week' | 'this_month';
export type VisitWhen = 'today' | 'tomorrow' | 'overdue' | 'upcoming';

export const CREATED_CHOICES: { key: CreatedWhen; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'this_week', label: 'This week' },
  { key: 'this_month', label: 'This month' },
];

export const VISIT_CHOICES: { key: VisitWhen; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'tomorrow', label: 'Tomorrow' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'upcoming', label: 'Upcoming' },
];

/** The field the New chip reads. Every record has it. */
export const CREATED_FIELD = 'created_at';

/** The operators a chip writes, so it only ever takes back its own conditions. */
const CHIP_OPERATORS = new Set(['today', 'tomorrow', 'yesterday', 'this_week', 'this_month', 'less_than', 'greater_than', 'is_not_empty']);

/**
 * What one choice means as conditions on a field. `today` is the calendar day
 * as "2026-10-10", the same value the Task chip's Overdue and Upcoming use.
 */
export function choiceConditions(field: string, when: CreatedWhen | VisitWhen, today: string): FilterCondition[] {
  if (when === 'overdue') {
    // A date nobody set is not overdue.
    return [{ field, operator: 'is_not_empty' }, { field, operator: 'less_than', value: today }];
  }
  if (when === 'upcoming') return [{ field, operator: 'greater_than', value: today }];
  return [{ field, operator: when }];
}

/** Which choice the filter currently holds on this field, or null. */
export function chosenWhen<T extends string>(filter: FilterGroup, field: string, keys: readonly T[]): T | null {
  for (const item of filter.conditions) {
    if (isFilterGroup(item) || item.field !== field) continue;
    let when: string = item.operator;
    if (item.operator === 'less_than') when = 'overdue';
    if (item.operator === 'greater_than') when = 'upcoming';
    if ((keys as readonly string[]).includes(when)) return when as T;
  }
  return null;
}

/** The filter without anything a chip wrote on this field. */
export function withoutChoice(filter: FilterGroup, field: string): FilterGroup {
  return {
    ...filter,
    conditions: filter.conditions.filter((item) => isFilterGroup(item) || item.field !== field || !CHIP_OPERATORS.has(item.operator)),
  };
}

/**
 * The filter narrowed to one choice, replacing any choice already on that
 * field. An OR group is kept whole inside an AND, so a choice narrows the list
 * rather than widening it.
 */
export function withChoice(filter: FilterGroup, field: string, conditions: FilterCondition[]): FilterGroup {
  const rest = withoutChoice(filter, field);
  const kept = rest.logic === 'OR' && rest.conditions.length ? [rest] : rest.conditions;
  return { logic: 'AND', conditions: [...kept, ...conditions] };
}
