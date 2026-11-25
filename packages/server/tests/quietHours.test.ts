import { describe, expect, it } from 'vitest';
import { isQuietAt, type QuietWindow } from '../src/utils/quietHours.js';
import { makeDatabaseHealth } from '../src/core/databaseHealth.js';
import { config } from '../src/config.js';

const ist: QuietWindow = { enabled: true, start: '00:30', end: '06:30', timeZone: 'Asia/Kolkata' };
// 2026-11-02 in India is UTC + 5:30, so 00:29 IST is 18:59 UTC the day before.
const atIst = (hhmm: string) => new Date(`2026-11-02T${hhmm}:00+05:30`);

describe('quiet hours', () => {
  it('is quiet from 00:30 up to, not including, 06:30 India time', () => {
    expect(isQuietAt(atIst('00:29'), ist)).toBe(false);
    expect(isQuietAt(atIst('00:30'), ist)).toBe(true);
    expect(isQuietAt(atIst('03:00'), ist)).toBe(true);
    expect(isQuietAt(atIst('06:29'), ist)).toBe(true);
    expect(isQuietAt(atIst('06:30'), ist)).toBe(false);
    expect(isQuietAt(atIst('14:00'), ist)).toBe(false);
  });

  it('follows the window time zone, not the server clock', () => {
    // 03:00 IST is 21:30 UTC the day before: quiet in India, not in UTC terms.
    expect(isQuietAt(atIst('03:00'), { ...ist, timeZone: 'UTC' })).toBe(false);
  });

  it('handles a window that crosses midnight', () => {
    const w = { ...ist, start: '22:00', end: '05:00' };
    expect(isQuietAt(atIst('23:30'), w)).toBe(true);
    expect(isQuietAt(atIst('04:59'), w)).toBe(true);
    expect(isQuietAt(atIst('12:00'), w)).toBe(false);
  });

  it('can be switched off, and never throws on bad settings', () => {
    expect(isQuietAt(atIst('03:00'), { ...ist, enabled: false })).toBe(false);
    expect(isQuietAt(atIst('03:00'), { ...ist, timeZone: 'Not/AZone' })).toBe(false);
    // A garbled time falls back to the default 00:30-06:30.
    expect(isQuietAt(atIst('03:00'), { ...ist, start: 'abc' })).toBe(true);
    expect(isQuietAt(atIst('03:00'), { ...ist, start: '07:00', end: '07:00' })).toBe(false);
  });

  it('defaults to 00:30-06:30 Asia/Kolkata', () => {
    expect(config.quietHours).toMatchObject({ enabled: true, start: '00:30', end: '06:30', timeZone: 'Asia/Kolkata' });
  });
});

describe('the health check during quiet hours', () => {
  it('reuses a good answer however old, so the database is not woken', async () => {
    let clock = 0; let asked = 0; let quiet = false;
    const check = makeDatabaseHealth(async () => { asked++; return true; }, () => clock, () => quiet);
    await check();
    quiet = true;
    clock += 5 * 3_600_000;
    expect(await check()).toBe(true);
    expect(asked).toBe(1);
  });

  it('still asks when there is no answer yet, a bad one, or fresh=true', async () => {
    let clock = 0; let asked = 0;
    const check = makeDatabaseHealth(async () => { asked++; return true; }, () => clock, () => true);
    await check();            // first ask after a start must be real
    await check(true);        // explicit fresh
    expect(asked).toBe(2);
    let ok = false; let n = 0;
    const bad = makeDatabaseHealth(async () => { n++; return ok; }, () => clock, () => true);
    await bad();
    clock += 20_000; ok = true;
    expect(await bad()).toBe(true); // a bad answer is rechecked, not trusted
    expect(n).toBe(2);
  });
});

describe('the semantic index switch', () => {
  it('is off by default and meaning-search answers with nothing instead of failing', async () => {
    expect(config.semanticIndex.enabled).toBe(false);
    const { indexPending, search } = await import('../src/core/search/semantic.js');
    expect(await indexPending()).toEqual({ embedded: 0, skipped: 0 });
    expect(await search('who wants possession before diwali', {} as never)).toEqual([]);
  });
});
