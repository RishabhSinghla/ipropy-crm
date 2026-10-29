import { expect, it } from 'vitest';
import type { FieldMeta } from '@ipropy/shared';
import { categorySearchField } from '../src/lib/categorySearch';

const f = (over: Partial<FieldMeta>): FieldMeta => ({ name: 'x', columnName: 'x', label: 'X', config: {}, ...over } as FieldMeta);

it('finds the category field by its column', () => {
  expect(categorySearchField([f({ name: 'locality' }), f({ name: 'category', columnName: 'category' })])?.name).toBe('category');
});
it('still finds it after an admin renames the label', () => {
  expect(categorySearchField([f({ name: 'kind', columnName: 'k', label: 'Property type', config: { picklist: 'category' } })])?.name).toBe('kind');
});
it('answers nothing where a module has no category', () => {
  expect(categorySearchField([f({ name: 'locality' })])).toBeUndefined();
});
