import { describe, expect, it } from 'vitest';
import { isStaleAppError, mayRecoverNow, RECOVER_AT_MOST_EVERY_MS } from '../src/lib/staleApp';

describe('recognising an old or damaged copy of the app', () => {
  it('knows the real message from the live site', () => {
    expect(isStaleAppError('Failed to fetch dynamically imported module: https://crm.ipropy.com/assets/Layout-DRTju-f-.js')).toBe(true);
  });

  it('knows the other browsers\' wordings', () => {
    expect(isStaleAppError('error loading dynamically imported module: https://x/assets/a.js')).toBe(true);
    expect(isStaleAppError('Importing a module script failed.')).toBe(true);
    expect(isStaleAppError('Loading chunk 12 failed.')).toBe(true);
    expect(isStaleAppError('Unable to preload CSS for /assets/a.css')).toBe(true);
  });

  it('leaves ordinary errors alone', () => {
    expect(isStaleAppError('Cannot read properties of undefined')).toBe(false);
    expect(isStaleAppError('Network request failed')).toBe(false);
  });
});

describe('reloading at most once a minute', () => {
  const now = 1_000_000;
  it('recovers the first time', () => {
    expect(mayRecoverNow(null, now)).toBe(true);
  });
  it('does not loop: a second failure within a minute is left showing', () => {
    expect(mayRecoverNow(now - 5_000, now)).toBe(false);
  });
  it('tries again once a minute has passed', () => {
    expect(mayRecoverNow(now - RECOVER_AT_MOST_EVERY_MS, now)).toBe(true);
  });
});
