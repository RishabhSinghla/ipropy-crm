import { describe, expect, it } from 'vitest';
import { canonicalFilter, withCreatedToday } from '../src/lib/newRecordsQuery';

describe('New records prefetch', () => {
  it('reuses the same key when transient owner filters move before or after today', () => {
    const owner = { field: 'assigned_to', operator: 'equals' as const, value: 'agent' };
    const today = { field: 'created_at', operator: 'today' as const };
    expect(canonicalFilter(withCreatedToday({ logic: 'AND', conditions: [owner] })))
      .toEqual(canonicalFilter({ logic: 'AND', conditions: [today, owner] }));
  });
  it('keeps an OR group intact rather than widening the new-record query', () => {
    const alternatives = { logic: 'OR' as const, conditions: [{ field: 'status', operator: 'equals' as const, value: 'Hot' }] };
    expect(withCreatedToday(alternatives).conditions[0]).toEqual(alternatives);
    expect(withCreatedToday(alternatives).logic).toBe('AND');
  });
});
