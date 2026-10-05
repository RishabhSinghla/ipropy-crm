import { expect, it } from 'vitest';
import { hasFavouriteFilter } from '../src/lib/favouritesFilter';

it('recognises favourites inside a combined filter, regardless of property order', () => {
  expect(hasFavouriteFilter({ logic: 'AND', conditions: [{ operator: 'is_true', field: 'favourite' }] })).toBe(true);
  expect(hasFavouriteFilter({ logic: 'AND', conditions: [{ logic: 'OR', conditions: [{ field: 'favourite', operator: 'is_true' }] }] })).toBe(true);
  expect(hasFavouriteFilter({ logic: 'AND', conditions: [{ field: 'favourite', operator: 'is_false' }] })).toBe(false);
  expect(hasFavouriteFilter(null)).toBe(false);
});
