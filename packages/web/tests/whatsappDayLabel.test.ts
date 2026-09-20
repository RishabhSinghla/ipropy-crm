/**
 * The date on a conversation, as WhatsApp labels it.
 *
 * Every bubble used to print its own full date — "20 Sept, 03:42 pm" forty
 * times for one afternoon. The chip down the middle replaced that, and the
 * thing worth pinning is that it compares *calendar days*, not hours elapsed:
 * 11pm and 1am are different days however close they are, and getting that
 * wrong puts "Today" on yesterday's messages.
 */
import { describe, expect, it } from 'vitest';
import { bubbleTime, dayLabel } from '../src/lib/whatsapp';

const at = (y: number, m: number, d: number, h = 12): Date => new Date(y, m - 1, d, h);

describe('the day chip above a message', () => {
  const now = at(2026, 9, 20, 15);

  it('says Today and Yesterday', () => {
    expect(dayLabel(at(2026, 9, 20, 9), now)).toBe('Today');
    expect(dayLabel(at(2026, 9, 19, 23), now)).toBe('Yesterday');
  });

  it('counts calendar days, not hours', () => {
    // Two hours apart, either side of midnight: two different days.
    expect(dayLabel(at(2026, 9, 19, 23), at(2026, 9, 20, 1))).toBe('Yesterday');
  });

  it('names the weekday inside the last week, then the date', () => {
    expect(dayLabel(at(2026, 9, 17), now)).toMatch(/day$/);
    expect(dayLabel(at(2026, 9, 1), now)).toContain('September');
    // A different year has to say so, or "3 January" is ambiguous.
    expect(dayLabel(at(2025, 1, 3), now)).toContain('2025');
  });
});

describe('the clock on a bubble', () => {
  it('is a time and not a date', () => {
    const shown = bubbleTime(at(2026, 9, 20, 15));
    expect(shown).not.toMatch(/Sep|09|20\b/);
    expect(shown).toMatch(/\d/);
  });
});
