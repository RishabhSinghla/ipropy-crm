/**
 * What a list can be sorted by.
 *
 * **27 September 2026, the owner:** *"I need Nothing by default … and when we
 * want Sorting, Then the option we can choose 'Recently Update, Recently
 * create, Agent wise, Created by, updating By, Last Call Wise, Profile
 * Strength Wise, Task Wise' … else should be delete i.e Name, House, Portion,
 * category, Locality, Lead/Property Status."*
 *
 * 1 October 2026 he reversed the first half: "No sorting" is gone and the
 * default is Recently updated. What stays pinned is that the menu never grows
 * a row every time an admin flags a field.
 */
import { describe, expect, it } from 'vitest';
import { activeSortOption, sortOptions } from '../src/lib/listSort';

describe('the list sort menu', () => {
  it('offers the eight he asked for, and nothing about a field', () => {
    const labels = sortOptions('next_followup_at').map((option) => option.label);
    expect(labels).toEqual([
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

  // 1 October 2026: "No sorting" is gone and a list nobody sorted is
  // Recently updated — the server's own default, so the button tells the truth.
  it('reads Recently updated when nothing has been asked for', () => {
    const options = sortOptions('next_followup_at');
    expect(activeSortOption(options, undefined)?.key).toBe('updated');
    expect(options.some((option) => option.label === 'No sorting')).toBe(false);
  });

  it('finds the row for an order that is on', () => {
    const options = sortOptions('next_followup_at');
    expect(activeSortOption(options, 'last_call_at')?.key).toBe('lastCall');
    expect(activeSortOption(options, 'profile_strength')?.key).toBe('strength');
  });

  /*
    A column heading clicked in the table view is none of the eight. Answering
    Recently updated there would tell somebody their list is unsorted while it is
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
