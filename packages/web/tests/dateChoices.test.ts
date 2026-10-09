/** The New and Visits chips: each choice is plain filter conditions, and a chip only takes back its own. */
import { describe, expect, it } from 'vitest';
import type { FilterGroup } from '@ipropy/shared';
import { choiceConditions, chosenWhen, withChoice, withoutChoice } from '../src/lib/dateChoices';

const TODAY = '2026-10-10';
const VISIT_KEYS = ['today', 'tomorrow', 'overdue', 'upcoming'] as const;
const owner = { field: 'owner_id', operator: 'equals' as const, value: 'u1' };

describe('what each choice asks', () => {
  it('asks the calendar operators directly', () => {
    expect(choiceConditions('created_at', 'yesterday', TODAY)).toEqual([{ field: 'created_at', operator: 'yesterday' }]);
    expect(choiceConditions('created_at', 'this_month', TODAY)).toEqual([{ field: 'created_at', operator: 'this_month' }]);
  });

  it('counts a visit as overdue only when a date was set and has passed', () => {
    expect(choiceConditions('visit_on', 'overdue', TODAY)).toEqual([
      { field: 'visit_on', operator: 'is_not_empty' },
      { field: 'visit_on', operator: 'less_than', value: TODAY },
    ]);
    expect(choiceConditions('visit_on', 'upcoming', TODAY)).toEqual([{ field: 'visit_on', operator: 'greater_than', value: TODAY }]);
  });
});

describe('switching between choices', () => {
  it('replaces one choice with another and keeps everything else', () => {
    const overdue = withChoice({ logic: 'AND', conditions: [owner] }, 'visit_on', choiceConditions('visit_on', 'overdue', TODAY));
    expect(chosenWhen(overdue, 'visit_on', VISIT_KEYS)).toBe('overdue');
    const tomorrow = withChoice(overdue, 'visit_on', choiceConditions('visit_on', 'tomorrow', TODAY));
    expect(tomorrow.conditions).toEqual([owner, { field: 'visit_on', operator: 'tomorrow' }]);
    expect(chosenWhen(tomorrow, 'visit_on', VISIT_KEYS)).toBe('tomorrow');
  });

  it('clears back to exactly what was there before', () => {
    const chosen = withChoice({ logic: 'AND', conditions: [owner] }, 'visit_on', choiceConditions('visit_on', 'overdue', TODAY));
    expect(withoutChoice(chosen, 'visit_on').conditions).toEqual([owner]);
    expect(chosenWhen(withoutChoice(chosen, 'visit_on'), 'visit_on', VISIT_KEYS)).toBeNull();
  });

  it('never touches another field', () => {
    const both = withChoice(
      withChoice({ logic: 'AND', conditions: [] }, 'visit_on', choiceConditions('visit_on', 'today', TODAY)),
      'created_at', choiceConditions('created_at', 'this_week', TODAY),
    );
    expect(chosenWhen(both, 'visit_on', VISIT_KEYS)).toBe('today');
    expect(withoutChoice(both, 'created_at').conditions).toEqual([{ field: 'visit_on', operator: 'today' }]);
  });

  it('narrows an OR list rather than widening it', () => {
    const either: FilterGroup = { logic: 'OR', conditions: [owner, { field: 'status', operator: 'equals', value: 'Hot' }] };
    const narrowed = withChoice(either, 'created_at', choiceConditions('created_at', 'today', TODAY));
    expect(narrowed.logic).toBe('AND');
    expect(narrowed.conditions[0]).toEqual(either);
  });
});
