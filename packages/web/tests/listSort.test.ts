/**
 * What a list can be sorted by.
 *
 * **27 September 2026, the owner:** *"I need Nothing by default … and when we
 * want Sorting, Then the option we can choose 'Recently Update, Recently
 * create, Agent wise, Created by, updating By, Last Call Wise, Profile
 * Strength Wise, Task Wise' … else should be delete i.e Name, House, Portion,
 * category, Locality, Lead/Property Status."*
 *
 * Two things are worth pinning and neither is cosmetic: that nothing is chosen
 * when nothing has been asked for — a list that re-orders itself under a rep
 * working down it is what he was reporting — and that the menu no longer grows
 * a row every time an admin flags a field.
 */
import { describe, expect, it } from 'vitest';
import { activeSortOption, sortOptions } from '../src/lib/listSort';

describe('the list sort menu', () => {
  it('offers the eight he asked for, and nothing about a field', () => {
    const labels = sortOptions('next_followup_at').map((option) => option.label);
    expect(labels).toEqual([
      'No sorting',
      'Recently updated',
      'Recently created',
      'Agent wise',
      'Created by',
      'Updated by',
      'Last call wise',
      'Profile strength wise',
      'Task wise',
    ]);
  });

  it('drops the task row on a module with no follow-up field', () => {
    expect(sortOptions(undefined).some((option) => option.key === 'task')).toBe(false);
  });

  /*
    The follow-up column is called two different things in the two modules and
    has been since the CRM shipped, so the caller finds it through metadata and
    this list never names it.
  */
  it('takes the task field as it is given, whatever it is called', () => {
    expect(sortOptions('next_follow_up').find((o) => o.key === 'task')?.by).toBe('next_follow_up');
  });

  it('chooses nothing when nothing has been asked for', () => {
    const options = sortOptions('next_followup_at');
    expect(activeSortOption(options, undefined)?.key).toBe('none');
    expect(activeSortOption(options, undefined)?.by).toBeUndefined();
  });

  it('finds the row for an order that is on', () => {
    const options = sortOptions('next_followup_at');
    expect(activeSortOption(options, 'last_call_at')?.key).toBe('lastCall');
    expect(activeSortOption(options, 'profile_strength')?.key).toBe('strength');
  });

  /*
    A column heading clicked in the table view is none of the eight. Answering
    "No sorting" there would tell somebody their list is unsorted while it is
    plainly sorted by the column they just clicked.
  */
  it('claims none of them for a column the table sorted by', () => {
    expect(activeSortOption(sortOptions('next_followup_at'), 'locality')).toBeNull();
  });

  it('gives every option a direction to explain', () => {
    for (const option of sortOptions('next_followup_at')) {
      expect(option.ascHint.length, option.label).toBeGreaterThan(0);
      expect(option.descHint.length, option.label).toBeGreaterThan(0);
    }
  });
});
