/**
 * Reading when a photo was taken.
 *
 * The timezone arithmetic is the whole risk. EXIF `DateTimeOriginal` is local
 * wall-clock time with no offset attached, so reading it as UTC in India puts
 * every photo five and a half hours early — which across a day of site visits
 * is not a rounding error, it is one or two properties' worth of drift, and
 * photos file against the wrong builder floor.
 */
import { describe, expect, it } from 'vitest';
import { applyOffset, offsetMinutesAt, parseOffset } from '../../src/core/capture/captureTime.js';

describe('parseOffset', () => {
  it('reads the EXIF 2.31 offset tag in either spelling', () => {
    expect(parseOffset('+05:30')).toBe(330);
    expect(parseOffset('+0530')).toBe(330);
    expect(parseOffset('-08:00')).toBe(-480);
    expect(parseOffset('+00:00')).toBe(0);
  });

  it('returns null for anything that is not an offset', () => {
    // A missing or malformed tag must fall through to the configured timezone,
    // not be treated as UTC.
    expect(parseOffset(undefined)).toBeNull();
    expect(parseOffset('')).toBeNull();
    expect(parseOffset('IST')).toBeNull();
    expect(parseOffset('5:30')).toBeNull();
  });
});

describe('offsetMinutesAt', () => {
  it('knows India is +5:30 all year', () => {
    expect(offsetMinutesAt('Asia/Kolkata', new Date('2026-01-15T00:00:00Z'))).toBe(330);
    expect(offsetMinutesAt('Asia/Kolkata', new Date('2026-07-15T00:00:00Z'))).toBe(330);
  });

  it('follows daylight saving where it exists', () => {
    // The reason this is computed rather than hardcoded: a team outside India
    // does not have one offset, it has two.
    expect(offsetMinutesAt('Europe/London', new Date('2026-01-15T12:00:00Z'))).toBe(0);
    expect(offsetMinutesAt('Europe/London', new Date('2026-07-15T12:00:00Z'))).toBe(60);
    expect(offsetMinutesAt('America/New_York', new Date('2026-01-15T12:00:00Z'))).toBe(-300);
  });

  it('falls back to UTC for a timezone it does not recognise', () => {
    expect(offsetMinutesAt('Not/AZone', new Date())).toBe(0);
  });
});

describe('applyOffset', () => {
  it('turns a wall-clock reading into the instant it actually was', () => {
    // A photo whose EXIF says 09:03 in Greenfield was taken at 03:33 UTC.
    // exif-reader hands back the naive value as though it were UTC.
    const naive = new Date('2026-08-11T09:03:00Z');
    expect(applyOffset(naive, 330).toISOString()).toBe('2026-08-11T03:33:00.000Z');
  });

  it('is a no-op at UTC', () => {
    const naive = new Date('2026-08-11T09:03:00Z');
    expect(applyOffset(naive, 0).toISOString()).toBe('2026-08-11T09:03:00.000Z');
  });

  it('goes the other way west of Greenwich', () => {
    const naive = new Date('2026-08-11T09:03:00Z');
    expect(applyOffset(naive, -300).toISOString()).toBe('2026-08-11T14:03:00.000Z');
  });

  it('lands a morning shoot inside its own visit, not the previous one', () => {
    // The failure this prevents, spelled out: a visit from 09:03 to 09:18 local
    // is 03:33–03:48 UTC. Read naively, a 09:07 photo would be 09:07 UTC —
    // hours later, and inside whichever visit was happening at 14:37 local.
    const visitStart = applyOffset(new Date('2026-08-11T09:03:00Z'), 330);
    const visitEnd = applyOffset(new Date('2026-08-11T09:18:00Z'), 330);
    const photo = applyOffset(new Date('2026-08-11T09:07:00Z'), 330);

    expect(photo.getTime()).toBeGreaterThanOrEqual(visitStart.getTime());
    expect(photo.getTime()).toBeLessThanOrEqual(visitEnd.getTime());

    const naivePhoto = new Date('2026-08-11T09:07:00Z');
    expect(naivePhoto.getTime()).toBeGreaterThan(visitEnd.getTime());
  });
});
