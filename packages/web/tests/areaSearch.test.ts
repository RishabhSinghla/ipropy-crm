import { expect, it } from 'vitest';
import type { FieldMeta } from '@ipropy/shared';
import { areaSearchRange } from '../src/lib/areaSearch';

const size = { name: 'area', config: { unitOptions: [
  { value: 'sqft', label: 'Feet', factorSqft: 1 }, { value: 'sqyd', label: 'Yards', factorSqft: 9 },
  { value: 'bigha', label: 'Bigha', factorSqft: null },
] } } as FieldMeta;
it('converts both bounds and preserves the historical blank-unit fallback', () => {
  const range = areaSearchRange(size, { name: 'area_unit', defaultValue: 'sqft' } as FieldMeta, 100, 200)!;
  expect(range.conditions).toHaveLength(2);
  expect(JSON.stringify(range)).toContain('900');
  expect(JSON.stringify(range)).toContain('1800');
  expect(JSON.stringify(range)).toContain('is_empty');
  expect(JSON.stringify(range)).not.toContain('bigha');
  expect((range.conditions[1] as { conditions: unknown[] }).conditions.slice(1)).toEqual([
    { field: 'area', operator: 'greater_or_equal', value: 100 }, { field: 'area', operator: 'less_or_equal', value: 200 },
  ]);
});
it('does not add a range when neither bound is chosen', () => {
  expect(areaSearchRange(size, undefined)).toBeUndefined();
});
it('does not ignore a selected range when conversion metadata is missing', () => {
  const range = areaSearchRange({ name: 'area', config: {} } as FieldMeta, { name: 'area_unit' } as FieldMeta, 100);
  expect(range).toEqual({ logic: 'AND', conditions: [
    { field: 'area', operator: 'is_empty' }, { field: 'area', operator: 'is_not_empty' },
  ] });
});
