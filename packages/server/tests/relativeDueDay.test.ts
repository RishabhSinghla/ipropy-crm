/**
 * A follow-up date said the way a rep thinks about it.
 *
 * The trap this exists to pin: a date column arrives as `YYYY-MM-DD`, and
 * `new Date('2026-09-17')` is midnight **UTC** — 5:30am the same morning in
 * India. Subtract raw milliseconds and today's follow-up reads as "Tomorrow"
 * for the first five and a half hours of every working day, which is exactly
 * the window a rep opens the CRM in.
 *
 * So the comparison is calendar day against calendar day, and these cases fix
 * that in place.
 */
import { describe, expect, it } from 'vitest';
import { relativeDueDay } from '@ipropy/shared';

/** 17 Sept 2026, 08:00 local — inside the window the UTC bug used to break. */
const NOW = new Date(2026, 8, 17, 8, 0, 0);

describe('a due date against today', () => {
  it('calls today today, at 8am, on a bare date string', () => {
    expect(relativeDueDay('2026-09-17', NOW)).toMatchObject({ label: 'Today', tone: 'today', days: 0 });
  });

  it('still calls today today just after midnight — the UTC-offset case', () => {
    const justAfterMidnight = new Date(2026, 8, 17, 0, 30, 0);
    expect(relativeDueDay('2026-09-17', justAfterMidnight)).toMatchObject({ label: 'Today', days: 0 });
  });

  it('still calls today today late at night', () => {
    const lateEvening = new Date(2026, 8, 17, 23, 45, 0);
    expect(relativeDueDay('2026-09-17', lateEvening)).toMatchObject({ label: 'Today', days: 0 });
  });

  it('names tomorrow', () => {
    expect(relativeDueDay('2026-09-18', NOW)).toMatchObject({ label: 'Tomorrow', tone: 'tomorrow', days: 1 });
  });

  it('counts how overdue, in whole days', () => {
    expect(relativeDueDay('2026-09-16', NOW)).toMatchObject({ label: 'Overdue (1d)', tone: 'overdue', days: -1 });
    expect(relativeDueDay('2026-09-15', NOW)).toMatchObject({ label: 'Overdue (2d)', tone: 'overdue' });
    expect(relativeDueDay('2026-08-18', NOW)).toMatchObject({ tone: 'overdue', days: -30 });
  });

  it('keeps the next week close, and dates a distant one', () => {
    expect(relativeDueDay('2026-09-22', NOW)).toMatchObject({ label: 'In 5 days', tone: 'soon' });
    const far = relativeDueDay('2026-12-25', NOW);
    expect(far?.tone).toBe('later');
    expect(far?.label).toMatch(/Dec/);
  });

  it('handles a datetime, not just a bare date', () => {
    expect(relativeDueDay(new Date(2026, 8, 17, 18, 30), NOW)).toMatchObject({ label: 'Today' });
    expect(relativeDueDay(new Date(2026, 8, 16, 23, 59), NOW)).toMatchObject({ tone: 'overdue', days: -1 });
  });

  it('says nothing about an empty or unreadable date', () => {
    expect(relativeDueDay(null)).toBeNull();
    expect(relativeDueDay(undefined)).toBeNull();
    expect(relativeDueDay('')).toBeNull();
    expect(relativeDueDay('not a date', NOW)).toBeNull();
  });

  it('crosses a month and a year boundary by calendar, not by 30-day arithmetic', () => {
    const newYearsEve = new Date(2026, 11, 31, 22, 0, 0);
    expect(relativeDueDay('2027-01-01', newYearsEve)).toMatchObject({ label: 'Tomorrow', days: 1 });
    expect(relativeDueDay('2026-12-31', newYearsEve)).toMatchObject({ label: 'Today', days: 0 });
  });
});
