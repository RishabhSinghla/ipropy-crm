/**
 * The limits that decide whether a linked number survives.
 *
 * Everything else about linking a phone is plumbing that fails loudly. These
 * three rules fail silently and expensively: get them wrong and the CRM sends
 * too much, too fast, at the wrong hour, and WhatsApp removes the number a rep
 * has been using with customers for years. There is no undo for that, which is
 * why they are pure functions with tests rather than conditions buried in a
 * query.
 */
import { describe, expect, it } from 'vitest';
import {
  GAP_JITTER_SECONDS,
  MIN_GAP_SECONDS,
  SEND_FROM_HOUR,
  SEND_UNTIL_HOUR,
  hourInZone,
  warmUpCap,
  withinSendingHours,
} from '../../src/integrations/whatsapp/linkedDevice.js';

const IST = 'Asia/Kolkata';

describe('warmUpCap', () => {
  const linkedAgo = (days: number): Date => new Date(Date.now() - days * 86_400_000);

  it('starts low on a phone linked today', () => {
    // A new number that immediately sends a lot is the pattern that gets acted
    // on. Twenty-five is a working day on a property desk and looks like a
    // person.
    expect(warmUpCap(linkedAgo(0))).toBe(25);
    expect(warmUpCap(linkedAgo(2.9))).toBe(25);
  });

  it('climbs in steps over the first fortnight', () => {
    expect(warmUpCap(linkedAgo(3))).toBe(50);
    expect(warmUpCap(linkedAgo(6.9))).toBe(50);
    expect(warmUpCap(linkedAgo(7))).toBe(100);
    expect(warmUpCap(linkedAgo(13.9))).toBe(100);
    expect(warmUpCap(linkedAgo(14))).toBe(200);
    expect(warmUpCap(linkedAgo(400))).toBe(200);
  });

  it('treats a link with no date as brand new', () => {
    // `linked_at` is null until the phone actually scans. Reading that as "old
    // enough for the full allowance" would hand a fresh number the 200 ceiling
    // on its first day, which is precisely backwards.
    expect(warmUpCap(null)).toBe(25);
  });

  it('never goes down as a link ages', () => {
    const caps = [0, 1, 3, 5, 7, 10, 14, 30, 365].map((d) => warmUpCap(linkedAgo(d)));
    for (let i = 1; i < caps.length; i++) {
      expect(caps[i]).toBeGreaterThanOrEqual(caps[i - 1]!);
    }
  });
});

describe('hourInZone', () => {
  it('reads the hour where the business is, not where the server is', () => {
    // The whole point. 20:00 UTC is 01:30 the next day in Mumbai, and a server
    // asking `getHours()` would answer 20 and happily send at half past one in
    // the morning.
    const at = new Date('2026-08-16T20:00:00Z');
    expect(hourInZone('UTC', at)).toBe(20);
    expect(hourInZone(IST, at)).toBe(1);
  });

  it('handles the half-hour offset without rounding it away', () => {
    // 03:45 UTC is 09:15 IST. An implementation that worked in whole hours
    // would put this at 08:45 and refuse a send that should be allowed.
    expect(hourInZone(IST, new Date('2026-08-16T03:45:00Z'))).toBe(9);
  });

  it('falls back to UTC rather than throwing on a nonsense timezone', () => {
    // A bad `org.timezone` is an admin typo. Refusing to send anything at all
    // until somebody fixes it is a worse answer than being briefly wrong.
    const at = new Date('2026-08-16T14:00:00Z');
    expect(hourInZone('Not/AZone', at)).toBe(14);
  });
});

describe('withinSendingHours', () => {
  const istAt = (hhmm: string): Date => new Date(`2026-08-16T${hhmm}:00+05:30`);

  it('allows the working day', () => {
    expect(withinSendingHours(IST, istAt('08:00'))).toBe(true);
    expect(withinSendingHours(IST, istAt('13:00'))).toBe(true);
    expect(withinSendingHours(IST, istAt('20:59'))).toBe(true);
  });

  it('refuses the night', () => {
    expect(withinSendingHours(IST, istAt('21:00'))).toBe(false);
    expect(withinSendingHours(IST, istAt('23:30'))).toBe(false);
    expect(withinSendingHours(IST, istAt('03:00'))).toBe(false);
    expect(withinSendingHours(IST, istAt('07:59'))).toBe(false);
  });

  it('is decided by the business timezone, not the process one', () => {
    // 22:30 UTC is 04:00 IST. A CRM in a UTC container must refuse this, and
    // would have allowed it reading the server clock.
    const lateInIndia = new Date('2026-08-16T22:30:00Z');
    expect(withinSendingHours(IST, lateInIndia)).toBe(false);
    expect(withinSendingHours('UTC', lateInIndia)).toBe(false);

    // And the reverse: 03:00 UTC is 08:30 IST, fine there and too early in UTC.
    const morningInIndia = new Date('2026-08-16T03:00:00Z');
    expect(withinSendingHours(IST, morningInIndia)).toBe(true);
    expect(withinSendingHours('UTC', morningInIndia)).toBe(false);
  });

  it('agrees with the hours it advertises', () => {
    // The settings screen prints these two numbers to the rep. If the check
    // ever stops matching them, the screen is lying about what the CRM does.
    expect(withinSendingHours(IST, istAt(`${String(SEND_FROM_HOUR).padStart(2, '0')}:00`))).toBe(true);
    expect(withinSendingHours(IST, istAt(`${String(SEND_UNTIL_HOUR).padStart(2, '0')}:00`))).toBe(false);
  });
});

describe('the gap between messages', () => {
  it('is long enough to look like typing, with real variation', () => {
    // A perfectly even cadence is itself a signal: nobody sends a message every
    // forty seconds on the dot for an hour. The jitter has to be a meaningful
    // share of the gap rather than a decorative few seconds.
    expect(MIN_GAP_SECONDS).toBeGreaterThanOrEqual(30);
    expect(GAP_JITTER_SECONDS).toBeGreaterThanOrEqual(MIN_GAP_SECONDS);
  });

  it('keeps a day inside the warm-up ceiling it is paired with', () => {
    // The two limits have to agree. If flat-out sending across the allowed
    // hours could not reach the daily cap, the cap would never bite and the
    // warm-up would be decoration.
    const averageGap = MIN_GAP_SECONDS + GAP_JITTER_SECONDS / 2;
    const perDay = ((SEND_UNTIL_HOUR - SEND_FROM_HOUR) * 3600) / averageGap;
    expect(perDay).toBeGreaterThan(warmUpCap(new Date(Date.now() - 30 * 86_400_000)));
  });
});
