/**
 * The chase date's chip is red once it has passed, and ordinary before that.
 *
 * **28 September 2026, the owner:** *"bring the overdue red back on followup
 * chip."* He had asked the morning before for every chip on the record header
 * to be one colour bar the stage, and then worked the screen — so overdue is
 * the second exception and the only other one.
 *
 * Tested here rather than in a browser because it cannot be reached from one:
 * `POST /api/records/:module` refuses a chase date in the past — *"Next
 * Follow-up is a task: choose today or a future date"* — so a record only
 * becomes overdue by the clock passing, and a spec driving the real API can
 * never manufacture one. The decision is pure, so this is where it belongs.
 */
import { describe, expect, it } from 'vitest';
import { HEADER_CHIP_OVERDUE, HEADER_CHIP_TONE, headerChipTone } from '../src/lib/headerChip';

/** A date that many days from today, as the CRM stores one. */
function day(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

describe('headerChipTone', () => {
  it('turns a chase date that has passed red', () => {
    expect(headerChipTone(day(-1))).toBe(HEADER_CHIP_OVERDUE);
    expect(headerChipTone(day(-90))).toBe(HEADER_CHIP_OVERDUE);
  });

  it('leaves today, tomorrow and later as the ordinary chip', () => {
    // Three chips shouting on one line is a line where none of them does.
    expect(headerChipTone(day(0))).toBe(HEADER_CHIP_TONE);
    expect(headerChipTone(day(1))).toBe(HEADER_CHIP_TONE);
    expect(headerChipTone(day(30))).toBe(HEADER_CHIP_TONE);
  });

  it('leaves a record nobody has promised to chase alone', () => {
    // No date is not a late date: an empty field must not read as a debt.
    expect(headerChipTone(null)).toBe(HEADER_CHIP_TONE);
    expect(headerChipTone(undefined)).toBe(HEADER_CHIP_TONE);
    expect(headerChipTone('')).toBe(HEADER_CHIP_TONE);
  });

  it('keeps the two tones apart', () => {
    // A test that passed while both strings were equal would prove nothing.
    expect(HEADER_CHIP_OVERDUE).not.toBe(HEADER_CHIP_TONE);
  });
});
