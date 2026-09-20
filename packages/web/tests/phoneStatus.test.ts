/**
 * Synced, idle or offline — and the difference has to be exact.
 *
 * The whole point of this screen is that "App open" is a promise: pressing
 * Call will ring that handset. A state that is generous about what counts as
 * open turns the screen into the same guess it replaced.
 */
import { describe, expect, it } from 'vitest';
import { reachability } from '../src/lib/phoneStatus';

const now = Date.parse('2026-09-20T12:00:00Z');
const ago = (ms: number): string => new Date(now - ms).toISOString();

describe('reachability', () => {
  it('is open only while the app has beaten recently', () => {
    expect(reachability({ app_open_at: ago(30_000), last_seen_at: ago(30_000) }, now)).toBe('open');
    // One missed beat is a blip; three minutes is not "open".
    expect(reachability({ app_open_at: ago(3 * 60_000), last_seen_at: ago(3 * 60_000) }, now)).toBe('idle');
  });

  it('is idle when the phone has been in touch but the app is shut', () => {
    expect(reachability({ app_open_at: null, last_seen_at: ago(2 * 60 * 60_000) }, now)).toBe('idle');
  });

  it('is offline after half a day of silence', () => {
    expect(reachability({ app_open_at: null, last_seen_at: ago(13 * 60 * 60_000) }, now)).toBe('offline');
  });

  it('separates a phone that has never spoken from one that has gone quiet', () => {
    // These read the same on a screen that only knows "not recently", and they
    // need different actions: one is a pairing that never completed.
    expect(reachability({ app_open_at: null, last_seen_at: null }, now)).toBe('never');
  });

  it('trusts an open app even when nothing else has happened', () => {
    // The case the old screen got wrong: a phone uploading no calls because
    // there are none to upload is not an offline phone.
    expect(reachability({ app_open_at: ago(10_000), last_seen_at: null }, now)).toBe('open');
  });
});
