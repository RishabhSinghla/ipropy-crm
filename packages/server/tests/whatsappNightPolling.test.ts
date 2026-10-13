import { describe, expect, it } from 'vitest';
import { isTimeToPoll } from '../src/integrations/whatsapp/business/pollInbound.js';

// India is UTC+5:30, so 10:00 UTC is 15:30 there and 20:00 UTC is 01:30 the next morning.
const at = (iso: string) => new Date(iso).getTime();

describe('when the WhatsApp reply poll runs', () => {
  it('runs every visit during the working day', () => {
    const noon = at('2026-10-13T06:30:00Z'); // 12:00 in India
    expect(isTimeToPoll(noon, noon - 60_000)).toBe(true);
    expect(isTimeToPoll(noon, noon - 1_000)).toBe(true);
  });

  it('waits ten minutes between visits at night, so the database can sleep', () => {
    const night = at('2026-10-13T20:00:00Z'); // 01:30 in India
    expect(isTimeToPoll(night, night - 60_000)).toBe(false);
    expect(isTimeToPoll(night, night - 9 * 60_000)).toBe(false);
    expect(isTimeToPoll(night, night - 10 * 60_000)).toBe(true);
  });

  it('allows for the timer drifting a few seconds', () => {
    const night = at('2026-10-13T20:00:00Z');
    expect(isTimeToPoll(night, night - (10 * 60_000 - 3_000))).toBe(true);
  });

  it('resumes the one-minute rhythm at 6 am and starts the quiet one at 11 pm', () => {
    expect(isTimeToPoll(at('2026-10-13T00:30:00Z'), at('2026-10-13T00:29:00Z'))).toBe(true);  // 06:00 India
    expect(isTimeToPoll(at('2026-10-13T17:30:00Z'), at('2026-10-13T17:29:00Z'))).toBe(false); // 23:00 India
    expect(isTimeToPoll(at('2026-10-13T17:00:00Z'), at('2026-10-13T16:59:00Z'))).toBe(true);  // 22:30 India
  });

  it('polls straight away after a restart in the middle of the night', () => {
    expect(isTimeToPoll(at('2026-10-13T20:00:00Z'), 0)).toBe(true);
  });
});
