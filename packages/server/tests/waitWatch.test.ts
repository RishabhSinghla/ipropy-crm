import { describe, expect, it } from 'vitest';
import { parseBusinessHours, readWatchSettings, waitedMinutes } from '../src/integrations/whatsapp/business/waitWatch.js';

const hours = parseBusinessHours({ start: '09:30', end: '19:00', days: [1, 2, 3, 4, 5, 6], timezone: 'Asia/Kolkata' });
// IST is UTC+5:30. 2026-10-26 is a Monday, 2026-10-25 a Sunday.
const ist = (iso: string): Date => new Date(`${iso}+05:30`);

describe('waitedMinutes counts only open hours', () => {
  it('counts plain minutes inside a working day', () => {
    expect(waitedMinutes(ist('2026-10-26T10:00:00'), ist('2026-10-26T10:20:30'), hours)).toBe(20);
  });
  it('a message at night starts counting at opening time', () => {
    // 22:00 Monday -> 09:30 Tuesday is still zero; at 09:45 it has waited 15.
    expect(waitedMinutes(ist('2026-10-26T22:00:00'), ist('2026-10-27T09:30:00'), hours)).toBe(0);
    expect(waitedMinutes(ist('2026-10-26T22:00:00'), ist('2026-10-27T09:45:00'), hours)).toBe(15);
  });
  it('a message just before closing counts only until closing, then the next morning', () => {
    expect(waitedMinutes(ist('2026-10-26T18:50:00'), ist('2026-10-27T09:40:00'), hours)).toBe(20);
  });
  it('a Sunday counts for nothing', () => {
    expect(waitedMinutes(ist('2026-10-25T11:00:00'), ist('2026-10-25T15:00:00'), hours)).toBe(0);
    expect(waitedMinutes(ist('2026-10-24T18:30:00'), ist('2026-10-26T09:40:00'), hours)).toBe(30 + 10);
  });
  it('missing or malformed hours mean always open', () => {
    const open = parseBusinessHours(undefined);
    expect(open).toBeNull();
    expect(waitedMinutes(ist('2026-10-25T01:00:00'), ist('2026-10-25T03:00:00'), open)).toBe(120);
    for (const bad of [{ start: '19:00', end: '09:00', days: [1], timezone: 'Asia/Kolkata' }, { start: '09:00', end: '18:00', days: [], timezone: 'Asia/Kolkata' }, { start: '09:00', end: '18:00', days: [1], timezone: 'Not/AZone' }, 'x']) {
      expect(parseBusinessHours(bad)).toBeNull();
    }
  });
  it('answers zero for a message from the future', () => {
    expect(waitedMinutes(ist('2026-10-26T12:00:00'), ist('2026-10-26T11:00:00'), hours)).toBe(0);
  });
});

describe('readWatchSettings clamps instead of refusing', () => {
  it('is on only for exactly true', () => {
    expect(readWatchSettings({ enabled: true }).enabled).toBe(true);
    for (const v of ['true', 1, null, undefined, 'yes']) expect(readWatchSettings({ enabled: v }).enabled).toBe(false);
  });
  it('keeps minutes in 5-240 and the second limit at least 5 above the first', () => {
    expect(readWatchSettings({})).toMatchObject({ firstMinutes: 15, secondMinutes: 60 });
    expect(readWatchSettings({ first: 1, second: 99999 })).toMatchObject({ firstMinutes: 5, secondMinutes: 240 });
    expect(readWatchSettings({ first: 60, second: 30 })).toMatchObject({ firstMinutes: 60, secondMinutes: 65 });
    expect(readWatchSettings({ first: 'abc', second: 'x' })).toMatchObject({ firstMinutes: 15, secondMinutes: 60 });
  });
});
