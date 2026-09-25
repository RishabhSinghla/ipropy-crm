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
import { bubbleTime, dayLabel, moduleTag, windowLeft } from '../src/lib/whatsapp';

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

  it('names the weekday with its date inside the last week, then the date alone', () => {
    // "Monday" alone left the reader counting back through the week.
    expect(dayLabel(at(2026, 9, 17), now)).toMatch(/^Thursday, 17 Sept?$/);
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

/**
 * The bar down the left of every chat: how long a free reply is still allowed.
 * The rule worth pinning is that it rounds **down** — telling a rep they have
 * 19 hours when they have 18h 50m is how a reply lands a minute too late.
 */
describe("the reply window's bar", () => {
  const now = new Date('2026-09-25T10:00:00Z');
  const inMs = (ms: number): string => new Date(now.getTime() + ms).toISOString();

  it('shows hours left, rounded down', () => {
    expect(windowLeft(inMs((18 * 60 + 50) * 60_000), now)).toEqual({ open: true, label: '18h' });
  });

  it('switches to minutes in the last hour', () => {
    expect(windowLeft(inMs(45 * 60_000), now)).toEqual({ open: true, label: '45m' });
  });

  it('says Exp once it has passed, or when there never was one', () => {
    expect(windowLeft(inMs(-1000), now)).toEqual({ open: false, label: 'Exp' });
    expect(windowLeft(null, now)).toEqual({ open: false, label: 'Exp' });
  });
});

describe('the LD / INV tag on a chat', () => {
  it("uses the module's own short label", () => {
    expect(moduleTag({ label: 'Leads', settings: { shortLabel: 'LD' } })).toBe('LD');
    expect(moduleTag({ label: 'Inventories', settings: { shortLabel: 'inv' } })).toBe('INV');
  });

  it('falls back to the first three letters for a module nobody has tagged', () => {
    expect(moduleTag({ label: 'Channel Partners' })).toBe('CHA');
  });

  it('is nothing for a chat with no record', () => {
    expect(moduleTag(undefined)).toBeNull();
  });
});
