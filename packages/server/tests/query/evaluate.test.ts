/**
 * Unit tests for core/query/evaluate.ts — the in-memory FilterGroup evaluator
 * used by workflow conditions and conditional visibility. Must stay in step
 * with the SQL builder it mirrors.
 */
import { describe, expect, it } from 'vitest';
import { applyOperator, collectFilterFields, evaluateFilter } from '../../src/core/query/evaluate.js';

describe('evaluateFilter — group logic', () => {
  it('treats an undefined/empty filter as always-true', () => {
    expect(evaluateFilter(undefined, {})).toBe(true);
    expect(evaluateFilter({ logic: 'AND', conditions: [] }, {})).toBe(true);
  });

  it('AND requires every condition, OR requires any', () => {
    const f = (logic: 'AND' | 'OR') => ({
      logic,
      conditions: [{ field: 'status', operator: 'equals', value: 'New' }, { field: 'is_converted', operator: 'is_false' }],
    });
    expect(evaluateFilter(f('AND'), { status: 'New', is_converted: false })).toBe(true);
    expect(evaluateFilter(f('AND'), { status: 'New', is_converted: true })).toBe(false);
    expect(evaluateFilter(f('OR'), { status: 'New', is_converted: true })).toBe(true);
    expect(evaluateFilter(f('OR'), { status: 'Old', is_converted: true })).toBe(false);
  });

  it('nests groups with their own logic', () => {
    const filter = {
      logic: 'OR' as const,
      conditions: [
        { logic: 'AND' as const, conditions: [{ field: 'status', operator: 'equals', value: 'Hot' }, { field: 'score', operator: 'greater_than', value: 80 }] },
        { field: 'rating', operator: 'equals', value: 'VIP' },
      ],
    };
    expect(evaluateFilter(filter, { status: 'Hot', score: 90 })).toBe(true);
    expect(evaluateFilter(filter, { status: 'Hot', score: 50 })).toBe(false);
    expect(evaluateFilter(filter, { rating: 'VIP' })).toBe(true);
    expect(evaluateFilter(filter, {})).toBe(false);
  });
});

describe('evaluateCondition — string/boolean operators', () => {
  it('equals is case-insensitive on strings and lenient on types', () => {
    expect(applyOperator('equals', 'New', 'NEW')).toBe(true);
    expect(applyOperator('equals', 'New', 'Hot')).toBe(false);
    expect(applyOperator('equals', true, 'true')).toBe(true);
    expect(applyOperator('equals', false, true)).toBe(false);
  });

  it('equals null means blank on either side', () => {
    expect(applyOperator('equals', null, null)).toBe(true);
    expect(applyOperator('equals', '', null)).toBe(true);
    expect(applyOperator('equals', 'x', null)).toBe(false);
  });

  it('contains / starts_with / ends_with', () => {
    expect(applyOperator('contains', 'Bengaluru', 'gal')).toBe(true);
    expect(applyOperator('not_contains', 'Bengaluru', 'gal')).toBe(false);
    expect(applyOperator('starts_with', 'Bengaluru', 'BEN')).toBe(true);
    expect(applyOperator('ends_with', 'Bengaluru', 'uru')).toBe(true);
  });

  it('is_empty / is_not_empty treat null, "" and [] as blank but not 0', () => {
    expect(applyOperator('is_empty', null)).toBe(true);
    expect(applyOperator('is_empty', '')).toBe(true);
    expect(applyOperator('is_empty', [])).toBe(true);
    expect(applyOperator('is_empty', 0)).toBe(false);
    expect(applyOperator('is_empty', 'x')).toBe(false);
    expect(applyOperator('is_not_empty', 'x')).toBe(true);
    expect(applyOperator('is_not_empty', '')).toBe(false);
  });

  it('is_true / is_false accept boolean-ish values', () => {
    expect(applyOperator('is_true', true)).toBe(true);
    expect(applyOperator('is_true', 'true')).toBe(true);
    expect(applyOperator('is_true', 1)).toBe(true);
    expect(applyOperator('is_false', false)).toBe(true);
    expect(applyOperator('is_false', 'false')).toBe(true);
    expect(applyOperator('is_false', null)).toBe(true);
    expect(applyOperator('is_true', 0)).toBe(false);
  });
});

describe('evaluateCondition — numeric/date comparison', () => {
  it('compares numbers, stripping currency separators', () => {
    expect(applyOperator('greater_than', 1_500_000, 1_000_000)).toBe(true);
    expect(applyOperator('greater_than', '₹1,50,00,000', 10_000_000)).toBe(true);
    expect(applyOperator('less_or_equal', 5, 5)).toBe(true);
  });

  it('compares dates when values are not numeric', () => {
    expect(applyOperator('greater_than', '2026-08-01', '2026-07-01')).toBe(true);
    expect(applyOperator('less_than', '2026-07-01', '2026-08-01')).toBe(true);
    expect(applyOperator('greater_than', '2026-08-01', 'not-a-date')).toBe(false);
  });

  it('between is inclusive on both ends', () => {
    expect(applyOperator('between', 50, 10, 100)).toBe(true);
    expect(applyOperator('between', 10, 10, 100)).toBe(true);
    expect(applyOperator('between', 101, 10, 100)).toBe(false);
  });

  it('blank values never satisfy a comparison', () => {
    expect(applyOperator('greater_than', null, 10)).toBe(false);
    expect(applyOperator('less_than', '', 10)).toBe(false);
  });
});

describe('evaluateCondition — membership operators', () => {
  it('in / not_in handle arrays and comma-separated strings', () => {
    expect(applyOperator('in', 'Hot', ['new', 'hot'])).toBe(true);
    expect(applyOperator('in', 'Hot', 'new, hot')).toBe(true);
    expect(applyOperator('not_in', 'Cold', ['new', 'hot'])).toBe(true);
    expect(applyOperator('not_in', 'Hot', ['new', 'hot'])).toBe(false);
  });

  it('has_any / has_all on arrays', () => {
    expect(applyOperator('has_any', ['vip', 'hot'], ['vip'])).toBe(true);
    expect(applyOperator('has_any', ['cold'], ['vip'])).toBe(false);
    expect(applyOperator('has_all', ['vip', 'hot'], ['vip', 'hot'])).toBe(true);
    expect(applyOperator('has_all', ['vip'], ['vip', 'hot'])).toBe(false);
    expect(applyOperator('has_all', null, ['vip'])).toBe(false);
  });
});

describe('evaluateCondition — people scoping', () => {
  it('is_me matches the ctx user id', () => {
    expect(applyOperator('is_me', 'u_1', undefined, undefined, { userId: 'u_1' })).toBe(true);
    expect(applyOperator('is_me', 'u_2', undefined, undefined, { userId: 'u_1' })).toBe(false);
  });

  it('is_my_team matches any of the ctx team ids', () => {
    expect(applyOperator('is_my_team', 'u_3', undefined, undefined, { teamIds: ['u_1', 'u_3'] })).toBe(true);
    expect(applyOperator('is_my_team', 'u_9', undefined, undefined, { teamIds: ['u_1', 'u_3'] })).toBe(false);
  });
});

describe('evaluateCondition — relative dates', () => {
  it('today / yesterday / tomorrow', () => {
    const now = new Date();
    expect(applyOperator('today', now)).toBe(true);
    expect(applyOperator('today', new Date(now.getTime() + 86400000))).toBe(false);

    const yesterday = new Date(now.getTime() - 86400000);
    expect(applyOperator('yesterday', yesterday)).toBe(true);

    const tomorrow = new Date(now.getTime() + 86400000);
    expect(applyOperator('tomorrow', tomorrow)).toBe(true);
  });

  it('this_week matches dates in the current ISO week', () => {
    const now = new Date();
    expect(applyOperator('this_week', now)).toBe(true);
  });

  it('last_n_days is an inclusive window ending now', () => {
    const now = new Date();
    expect(applyOperator('last_n_days', now, 7)).toBe(true);
    expect(applyOperator('last_n_days', new Date(now.getTime() - 2 * 86400000), 7)).toBe(true);
    expect(applyOperator('last_n_days', new Date(now.getTime() - 10 * 86400000), 7)).toBe(false);
  });

  it('older_than_n_days excludes the window', () => {
    const now = new Date();
    expect(applyOperator('older_than_n_days', new Date(now.getTime() - 10 * 86400000), 7)).toBe(true);
    expect(applyOperator('older_than_n_days', new Date(now.getTime() - 2 * 86400000), 7)).toBe(false);
  });

  it('unknown operators evaluate to false rather than throwing', () => {
    expect(applyOperator('frobnicate' as never, 'x', 'y')).toBe(false);
  });
});

describe('collectFilterFields', () => {
  it('collects top-level field names across nested groups, de-duplicated', () => {
    const filter = {
      logic: 'OR' as const,
      conditions: [
        { logic: 'AND' as const, conditions: [{ field: 'status', operator: 'equals', value: 'New' }, { field: 'project_id.city', operator: 'equals', value: 'Pune' }] },
        { field: 'status', operator: 'not_equals', value: 'Lost' },
      ],
    };
    expect(collectFilterFields(filter)).toEqual(['status', 'project_id']);
  });

  it('handles path-based conditions and empty filters', () => {
    expect(collectFilterFields(undefined)).toEqual([]);
    expect(collectFilterFields({ logic: 'AND', conditions: [{ field: 'owner_id', path: 'owner_id', operator: 'is_me' }] })).toEqual(['owner_id']);
  });
});
