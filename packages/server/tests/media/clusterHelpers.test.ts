import { describe, expect, it } from 'vitest';
import { minutesUntilAwake } from '../../src/integrations/outreach/sequences.js';
import { parseByteRange } from '../../src/utils/httpRange.js';

describe('parseByteRange', () => {
  it('parses and clamps explicit ranges', () => {
    expect(parseByteRange('bytes=10-19', 100)).toEqual({ ok: true, start: 10, end: 19 });
    expect(parseByteRange('bytes=90-999', 100)).toEqual({ ok: true, start: 90, end: 99 });
    expect(parseByteRange('bytes=25-', 100)).toEqual({ ok: true, start: 25, end: 99 });
  });

  it('supports suffix ranges and rejects invalid or multiple ranges', () => {
    expect(parseByteRange('bytes=-20', 100)).toEqual({ ok: true, start: 80, end: 99 });
    expect(parseByteRange('bytes=-500', 100)).toEqual({ ok: true, start: 0, end: 99 });
    expect(parseByteRange('bytes=100-101', 100)).toEqual({ ok: false });
    expect(parseByteRange('bytes=20-10', 100)).toEqual({ ok: false });
    expect(parseByteRange('bytes=0-1,5-6', 100)).toEqual({ ok: false });
  });
});

describe('minutesUntilAwake', () => {
  const at = (hour: number, minute = 0) => new Date(2026, 0, 1, hour, minute, 0, 0);

  it('handles quiet hours that wrap across midnight', () => {
    expect(minutesUntilAwake(21, 9, at(22, 30))).toBe(630);
    expect(minutesUntilAwake(21, 9, at(8, 45))).toBe(15);
    expect(minutesUntilAwake(21, 9, at(14))).toBe(0);
  });

  it('handles daytime quiet ranges and a disabled equal range', () => {
    expect(minutesUntilAwake(13, 15, at(13, 20))).toBe(100);
    expect(minutesUntilAwake(9, 9, at(9))).toBe(0);
  });
});

