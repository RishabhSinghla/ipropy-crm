import { describe, expect, it } from 'vitest';
import {
  detectDateOrder, normaliseDate, normalisePhone, normaliseUnit,
  splitAmountAndUnit, normaliseForField,
} from '../src/core/import/normalise.js';
import { field } from './helpers.js';

describe('reading dates out of a spreadsheet', () => {
  it('never guesses between two readings that are both possible', () => {
    // 03/04/2026 is the third of April here and the fourth of March to
    // `new Date()`. Silently choosing moves a follow-up by a month.
    expect(normaliseDate('03/04/2026', 'dmy').value).toBe('2026-04-03');
    expect(normaliseDate('03/04/2026', 'mdy').value).toBe('2026-03-04');
  });

  it('settles the order from the column when one row proves it', () => {
    // No thirteenth month, so this column is day-first and that is not a guess.
    expect(detectDateOrder(['03/04/2026', '13/04/2026'])).toEqual({ order: 'dmy', certain: true });
    expect(detectDateOrder(['04/13/2026', '01/02/2026'])).toEqual({ order: 'mdy', certain: true });
    expect(detectDateOrder(['2026-04-03'])).toEqual({ order: 'ymd', certain: true });
    // Every row readable both ways: undecidable, and it says so rather than
    // picking one.
    expect(detectDateOrder(['03/04/2026', '05/06/2026'])).toEqual({ order: null, certain: false });
  });

  it('reads the formats an Indian spreadsheet actually contains', () => {
    expect(normaliseDate('15-03-2026', 'dmy').value).toBe('2026-03-15');
    expect(normaliseDate('15/03/26', 'dmy').value).toBe('2026-03-15');
    expect(normaliseDate('2026-05-20', 'dmy').value).toBe('2026-05-20');
    expect(normaliseDate('20 May 2026', 'dmy').value).toBe('2026-05-20');
    expect(normaliseDate(45000, 'dmy').value).toBe('2023-03-15'); // Excel serial
  });

  it('refuses a date that does not exist rather than rolling it forward', () => {
    // `new Date(2026, 1, 31)` is the 3rd of March. A follow-up silently moved
    // into another month is worse than a row that fails with a reason.
    const out = normaliseDate('31-02-2026', 'dmy');
    expect(out.value).toBeNull();
    expect(out.problem).toContain('not a real date');
  });
});

describe('reading phone numbers', () => {
  it('treats the trunk prefix and the country code as presentation', () => {
    expect(normalisePhone('09876501234').value).toBe('9876501234');
    expect(normalisePhone('+91 98100 12345').value).toBe('9810012345');
    expect(normalisePhone('98100-12345').value).toBe('9810012345');
    expect(normalisePhone('0091 9810012345').value).toBe('9810012345');
  });

  it('will not shorten a number it cannot explain', () => {
    const out = normalisePhone('12345');
    expect(out.value).toBeNull();
    expect(out.problem).toContain('10-digit');
  });
});

describe('reading units', () => {
  const options = [
    { value: 'sqft', label: 'Sq. Ft.' },
    { value: 'sqyd', label: 'Sq. Yds.' },
    { value: 'sqm', label: 'Sq. Mtr.' },
  ];

  it('matches the spellings people type', () => {
    for (const spelling of ['Sq. Yds.', 'Sq Yard', 'sq yd', 'SQ.YDS', 'square yards']) {
      expect(normaliseUnit(spelling, options).value, spelling).toBe('sqyd');
    }
    for (const spelling of ['Sq.ft', 'sq feet', 'SQ FT', 'square foot']) {
      expect(normaliseUnit(spelling, options).value, spelling).toBe('sqft');
    }
  });

  it('says so rather than inventing a unit', () => {
    const out = normaliseUnit('bigha', options);
    expect(out.value).toBeNull();
    expect(out.problem).toContain('not one of the units');
  });

  it('separates a number from a unit written in the same cell', () => {
    expect(splitAmountAndUnit('250 Sq. Yds.')).toEqual({ amount: '250', unit: 'Sq. Yds.' });
    expect(splitAmountAndUnit('1,200 sqft')).toEqual({ amount: '1,200', unit: 'sqft' });
    expect(splitAmountAndUnit('250')).toEqual({ amount: '250', unit: null });
  });
});

describe('reading amounts', () => {
  const money = field({ name: 'budget', uitype: 'currency' });

  it('understands the shorthand this market is written in', () => {
    expect(normaliseForField(money, '1.75 Cr').value).toBe(17_500_000);
    expect(normaliseForField(money, '75 Lac').value).toBe(7_500_000);
    expect(normaliseForField(money, '₹2,25,00,000').value).toBe(22_500_000);
    expect(normaliseForField(money, 80_000).value).toBe(80_000);
  });

  it('keeps the number when a size carries its unit', () => {
    const area = field({ name: 'area', uitype: 'area' });
    expect(normaliseForField(area, '250 Sq. Yds.').value).toBe(250);
    expect(normaliseForField(area, '1,200').value).toBe(1200);
  });

  it('refuses text that is not an amount', () => {
    const out = normaliseForField(money, 'on request');
    expect(out.value).toBeNull();
    expect(out.problem).toContain('not an amount');
  });
});
