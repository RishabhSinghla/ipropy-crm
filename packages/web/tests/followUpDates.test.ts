import { describe, expect, it } from 'vitest';
import { followUpChip, howLongOverdue, localDay, quickFollowUpDates } from '../src/lib/followUpDates';

const now = new Date(2026, 8, 26, 10, 0); // 26 Sep 2026, 10 am local

describe('followUpChip', () => {
  it('says Today, Tomorrow and Pending', () => {
    expect(followUpChip('2026-09-26', now)).toEqual({ label: 'Today', tone: 'today' });
    expect(followUpChip('2026-09-27', now)).toEqual({ label: 'Tomorrow', tone: 'tomorrow' });
    expect(followUpChip('2026-10-05', now)).toEqual({ label: 'Pending', tone: 'pending' });
  });

  it('uses compact D, M and Y notation for a task overdue', () => {
    expect(followUpChip('2026-09-25', now)?.label).toBe('Overdue (1D)');
    expect(followUpChip('2026-09-24', now)?.label).toBe('Overdue (2D)');
    expect(followUpChip('2026-08-20', now)?.label).toBe('Overdue (1M)');
    expect(followUpChip('2025-09-01', now)?.label).toBe('Overdue (1Y)');
  });

  it('shows nothing when no date is set or the value is not a date', () => {
    expect(followUpChip(null, now)).toBeNull();
    expect(followUpChip('', now)).toBeNull();
    expect(followUpChip('soon', now)).toBeNull();
  });
});

describe('howLongOverdue', () => {
  it('counts in compact queue notation', () => {
    expect(howLongOverdue(1)).toBe('1D');
    expect(howLongOverdue(29)).toBe('29D');
    expect(howLongOverdue(30)).toBe('1M');
    expect(howLongOverdue(95)).toBe('3M');
    expect(howLongOverdue(800)).toBe('2Y');
  });
});

describe('quickFollowUpDates', () => {
  it('offers Today, Tomorrow, Next Week and Next Month as calendar days', () => {
    expect(quickFollowUpDates(now)).toEqual([
      { label: 'Today', value: '2026-09-26' },
      { label: 'Tomorrow', value: '2026-09-27' },
      { label: 'Next Week', value: '2026-10-03' },
      { label: 'Next Month', value: '2026-10-26' },
    ]);
  });

  it('keeps Next Month inside the next month at the end of a long one', () => {
    const lastOfJanuary = new Date(2027, 0, 31, 9);
    expect(quickFollowUpDates(lastOfJanuary)[3]!.value).toBe('2027-02-28');
  });

  it('uses the local day just after midnight, not UTC', () => {
    expect(localDay(new Date(2026, 8, 26, 0, 30))).toBe('2026-09-26');
  });
});
