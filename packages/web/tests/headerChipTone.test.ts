/**
 * The record header's chips: one light tone, and red once a chase date passes.
 *
 * A chip's colour is only ever visible in a browser, so these pin the two
 * things a screenshot cannot argue with — that the tones are genuinely
 * different, and that the line deciding between them reads the date rather
 * than anything else.
 *
 * The overdue case cannot be reached through the CRM's own API: creating a
 * record with a past follow-up is refused ("Next Follow-up is a task: choose
 * today or a future date"), and rightly so — a record becomes overdue by the
 * clock passing, which no test can wait for. So the decision is pinned here.
 */
import { describe, expect, it } from 'vitest';
import {
  HEADER_CHIP_OVERDUE, HEADER_CHIP_SHAPE, HEADER_CHIP_SHAPE_SM, HEADER_CHIP_TONE, headerChipTone,
} from '../src/lib/headerChip';

/** A date this many days from today, as the record stores it. */
const day = (offset: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

describe('record header chip', () => {
  it('has the same rounded height and weight for every fact', () => {
    expect(HEADER_CHIP_SHAPE).toContain('h-8');
    expect(HEADER_CHIP_SHAPE).toContain('rounded-full');
    expect(HEADER_CHIP_SHAPE).toContain('font-bold');
    expect(HEADER_CHIP_SHAPE).toContain('border');
  });

  it('has a small twin that is a whole string, not the big one plus h-6', () => {
    // Two heights in one class list are decided by Tailwind's stylesheet
    // order, not by which was written last — which is how the hero's chip
    // stayed 32px tall while its class list said 24.
    expect(HEADER_CHIP_SHAPE_SM).toContain('h-6');
    expect(HEADER_CHIP_SHAPE_SM).not.toContain('h-8');
    expect(HEADER_CHIP_SHAPE).not.toContain('h-6');
  });

  it('is light and wears the brand, so it moves when the theme does', () => {
    expect(HEADER_CHIP_TONE).toContain('bg-brand-50');
    expect(HEADER_CHIP_TONE).toContain('border-brand-200');
    expect(HEADER_CHIP_TONE).toContain('dark:bg-brand-950');
  });

  it('never uses an opacity modifier, which compiles to nothing on these colours', () => {
    // Every brand step is a bare `var(--brand-…)`, so Tailwind cannot put an
    // opacity into it and the rule simply never enters the stylesheet. Only a
    // browser in dark mode would show that, which is why it is pinned here.
    expect(`${HEADER_CHIP_TONE} ${HEADER_CHIP_OVERDUE}`).not.toMatch(/\/\d+/);
  });
});

describe('a chase date that has passed', () => {
  it('turns red', () => {
    expect(headerChipTone(day(-1))).toBe(HEADER_CHIP_OVERDUE);
    expect(headerChipTone(day(-90))).toBe(HEADER_CHIP_OVERDUE);
  });

  it('stays the ordinary tone while it is still to come', () => {
    expect(headerChipTone(day(0))).toBe(HEADER_CHIP_TONE);
    expect(headerChipTone(day(1))).toBe(HEADER_CHIP_TONE);
    expect(headerChipTone(day(30))).toBe(HEADER_CHIP_TONE);
  });

  it('stays the ordinary tone when there is no date at all', () => {
    expect(headerChipTone(null)).toBe(HEADER_CHIP_TONE);
    expect(headerChipTone(undefined)).toBe(HEADER_CHIP_TONE);
    expect(headerChipTone('')).toBe(HEADER_CHIP_TONE);
  });

  it('keeps the two tones genuinely apart', () => {
    expect(HEADER_CHIP_OVERDUE).not.toBe(HEADER_CHIP_TONE);
    expect(HEADER_CHIP_OVERDUE).toContain('text-red-700');
  });
});
