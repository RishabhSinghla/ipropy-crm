import { describe, it, expect } from 'vitest';
import { populatedQueueGroups, queueGroupFilter, queueGroupField } from '../src/lib/queueGroups';
import type { ModuleMeta } from '@ipropy/shared';

describe('locality queues', () => {
  it('is opt-in and requires an active metadata field', () => {
    const module = { settings: { queueGroupBy: 'locality' }, fields: [{ name: 'locality', isActive: true }] } as ModuleMeta;
    expect(queueGroupField(module)).toBe('locality');
    expect(queueGroupField({ ...module, settings: {} })).toBeUndefined();
    expect(queueGroupField({ ...module, fields: [] })).toBeUndefined();
  });
  it('shows populated localities rather than duplicate houses or unused options', () => {
    expect(populatedQueueGroups([
      { key: 'Greenfields Colony', label: 'Greenfields Colony', count: 103 },
      { key: 'unused', label: 'unused', count: 0 },
      { key: 'Ashoka Enclave', label: 'Ashoka Enclave', count: 2 },
    ]).map((group) => [group.key, group.count])).toEqual([
      ['Ashoka Enclave', 2], ['Greenfields Colony', 103],
    ]);
  });
  it('preserves the existing filter grammar and handles missing localities', () => {
    const existing = { logic: 'OR' as const, conditions: [{ field: 'house_no', operator: 'equals' as const, value: 'A' }] };
    expect(queueGroupFilter('locality', 'Greenfields Colony', existing).conditions).toEqual([
      existing, { field: 'locality', operator: 'equals', value: 'Greenfields Colony' },
    ]);
    expect(queueGroupFilter('locality', '').conditions).toEqual([{ field: 'locality', operator: 'is_empty' }]);
  });
});
