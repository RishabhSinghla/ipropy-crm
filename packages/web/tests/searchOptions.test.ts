import { expect, it } from 'vitest';
import { filterOptions, moveHighlight } from '../src/lib/searchOptions';

const options = [
  { value: '', label: 'Any type' },
  { value: 'plot', label: 'Residential Plot', keywords: 'sector 91 test group' },
  { value: 'floor', label: 'Builder Floor', keywords: 'greenfield' },
];

it('keeps everything for an empty search', () => expect(filterOptions(options, '  ')).toHaveLength(3));
it('matches the label, ignoring case', () => expect(filterOptions(options, 'FLOOR').map((o) => o.value)).toEqual(['floor']));
it('matches hidden keywords such as a project, number or group', () => {
  expect(filterOptions(options, 'sector 91').map((o) => o.value)).toEqual(['plot']);
  expect(filterOptions(options, 'greenfield').map((o) => o.value)).toEqual(['floor']);
});
it('needs every word typed, in any order', () => {
  expect(filterOptions(options, 'plot residential')).toHaveLength(1);
  expect(filterOptions(options, 'plot greenfield')).toHaveLength(0);
});
it('keeps the highlight inside the list', () => {
  expect(moveHighlight(0, -1, 3)).toBe(0);
  expect(moveHighlight(2, 1, 3)).toBe(2);
  expect(moveHighlight(1, 1, 3)).toBe(2);
  expect(moveHighlight(0, 1, 0)).toBe(-1);
});
