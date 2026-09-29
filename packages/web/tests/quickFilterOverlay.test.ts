import { describe, expect, it } from 'vitest';
import { countActiveQuickFilters } from '../src/lib/quickFilters';

describe('quick filter overlay', () => {
  it('counts every active live facet and advanced condition', () => {
    expect(countActiveQuickFilters({
      filter: {
        logic: 'AND',
        conditions: [
          { field: 'locality', operator: 'equals', value: 'Greenfields' },
          { field: 'budget', operator: 'greater_than', value: 10_000_000 },
        ],
      },
      stages: ['new', 'contacted'],
      agent: 'user-1',
      task: 'today',
      disposition: { outcomes: ['busy', 'connected'], never: false },
      types: ['buyer'],
    })).toBe(9);
  });

  it('treats never-called as one filter and an empty overlay as zero', () => {
    expect(countActiveQuickFilters({
      filter: { logic: 'AND', conditions: [] },
      stages: [],
      agent: null,
      task: null,
      disposition: { outcomes: [], never: true },
      types: [],
    })).toBe(1);

    expect(countActiveQuickFilters({
      filter: { logic: 'AND', conditions: [] },
      stages: [],
      agent: null,
      task: null,
      disposition: { outcomes: [], never: false },
      types: [],
    })).toBe(0);
  });
});
