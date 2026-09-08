import { describe, expect, it } from 'vitest';
import type { PicklistOption } from '@ipropy/shared';
import { optionsWithValue } from '../src/lib/picklistOptions';

/**
 * A stored value the dropdown never knew still has to render.
 *
 * Properties carry localities from before the City → Locality map covered
 * their city, so the edit form's <select> had no matching option: the field
 * opened blank, and saving wrote the blank over a real locality. These pin
 * the rule the phone control already follows — a stored value renders even
 * when no option backs it.
 */
function opts(...values: string[]): PicklistOption[] {
  return values.map((value, i) => ({ value, label: value, color: null, sequence: i, isActive: true }));
}

describe('optionsWithValue', () => {
  it('appends a stored value that is missing from the option list', () => {
    const out = optionsWithValue(opts('Powai', 'Kharadi'), 'Greenfield Colony');
    expect(out.map((o) => o.value)).toEqual(['Powai', 'Kharadi', 'Greenfield Colony']);
  });

  it('labels the appended value as itself, the way list views already show it', () => {
    const out = optionsWithValue(opts('Powai'), 'Greenfield Colony');
    expect(out[1].label).toBe('Greenfield Colony');
  });

  it('leaves the list alone when the value is already offered', () => {
    const list = opts('Powai', 'Kharadi');
    expect(optionsWithValue(list, 'Powai')).toBe(list);
  });

  it('leaves the list alone when nothing is stored', () => {
    const list = opts('Powai');
    expect(optionsWithValue(list, null)).toBe(list);
    expect(optionsWithValue(list, undefined)).toBe(list);
    expect(optionsWithValue(list, '')).toBe(list);
  });

  it('appends the stored value even when a dependency narrowing left nothing', () => {
    // restrictTo is applied before this helper: a city the map has never
    // heard of must not blank out the locality the record already carries.
    expect(optionsWithValue([], 'Greenfield Colony').map((o) => o.value)).toEqual(['Greenfield Colony']);
  });

  it('adds nothing when no value is stored and the list is empty', () => {
    expect(optionsWithValue([], null)).toEqual([]);
  });
});