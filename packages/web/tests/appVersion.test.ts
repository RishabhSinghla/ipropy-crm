/**
 * Which phone needs a new app.
 *
 * The case that matters is the one that looks like an edge: a build old enough
 * that it cannot report its own version. Every handset in this business is in
 * that state, and answering "up to date" for them would hide precisely the
 * phones that cannot place a call.
 */
import { describe, expect, it } from 'vitest';
import { updateAvailable } from '../src/lib/appVersion';

describe('updateAvailable', () => {
  it('offers an update to a build too old to name itself', () => {
    expect(updateAvailable('', '2.1.0')).toBe(true);
    expect(updateAvailable(null, '2.1.0')).toBe(true);
    expect(updateAvailable(undefined, '2.1.0')).toBe(true);
  });

  it('says nothing when the phone is current or ahead', () => {
    expect(updateAvailable('2.1.0', '2.1.0')).toBe(false);
    expect(updateAvailable('2.2.0', '2.1.0')).toBe(false);
  });

  it('compares numbers, not text', () => {
    // The one a string comparison gets wrong: "2.10.0" sorts before "2.9.0".
    expect(updateAvailable('2.9.0', '2.10.0')).toBe(true);
    expect(updateAvailable('2.10.0', '2.9.0')).toBe(false);
  });

  it('handles versions of different lengths', () => {
    expect(updateAvailable('2.1', '2.1.1')).toBe(true);
    expect(updateAvailable('2.1.0', '2.1')).toBe(false);
  });

  it('offers nothing when no build is published', () => {
    // A CRM with no APK on it must not tell every phone it is out of date.
    expect(updateAvailable('2.0.0', null)).toBe(false);
    expect(updateAvailable('', '')).toBe(false);
  });
});
