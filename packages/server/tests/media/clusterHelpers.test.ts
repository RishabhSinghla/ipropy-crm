import { describe, expect, it } from 'vitest';
import { buildImagePdf } from '../../src/core/media/pdf.js';
import { buildWaLink } from '../../src/integrations/whatsapp/deviceSend.js';
import { minutesUntilAwake } from '../../src/integrations/whatsapp/sequences.js';
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

describe('buildWaLink', () => {
  it('normalises Indian mobile numbers and percent-encodes the exact message', () => {
    expect(buildWaLink('98123 45678', 'Hi Riya — 2 BHK & terrace'))
      .toBe('https://wa.me/919812345678?text=Hi%20Riya%20%E2%80%94%202%20BHK%20%26%20terrace');
  });

  it('never lets an oversized prefill spill past the safety limit', () => {
    const link = buildWaLink('+91 98123 45678', 'x'.repeat(2_000));
    expect(decodeURIComponent(link.split('text=')[1])).toHaveLength(1_500);
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

describe('buildImagePdf', () => {
  it('writes a complete multi-page PDF with the expected page tree', () => {
    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const pdf = buildImagePdf([
      { jpeg: fakeJpeg, width: 1080, height: 1528 },
      { jpeg: fakeJpeg, width: 1080, height: 1528 },
    ]);
    const text = pdf.toString('latin1');

    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text).toContain('/Type /Pages /Count 2');
    expect(text).toContain('xref\n0 9\n');
    expect(text.endsWith('%%EOF\n')).toBe(true);
  });

  it('refuses to produce an empty document', () => {
    expect(() => buildImagePdf([])).toThrow('A PDF needs at least one page');
  });
});
