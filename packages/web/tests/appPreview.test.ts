/**
 * Seeing the app's screens in a desktop browser.
 *
 * Reviewing an app change used to mean: deploy, pick up the phone, open
 * Chrome, sign in, download the APK, install it, find the screen, photograph
 * it. Every one of those steps sits between a change and an opinion about it,
 * and the screens are ordinary React either way.
 *
 * The property that makes this safe is the one asserted hardest below: it
 * moves the **shell** and never `isNative`. A browser has no camera, no call
 * log and no dialler, so a preview must not be able to report that any of them
 * works.
 */
import { describe, expect, it } from 'vitest';
import { previewingTheAppShell } from '../src/lib/native';

/** A stand-in window with its own storage, so each case starts clean. */
function fakeWindow(search: string, stored?: string): {
  location: { search: string };
  localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
  read(): string | null;
} {
  const bag = new Map<string, string>();
  if (stored !== undefined) bag.set('ipropy.previewApp', stored);
  return {
    location: { search },
    localStorage: {
      getItem: (k) => bag.get(k) ?? null,
      setItem: (k, v) => { bag.set(k, v); },
      removeItem: (k) => { bag.delete(k); },
    },
    read: () => bag.get('ipropy.previewApp') ?? null,
  };
}

describe('the app preview flag', () => {
  it('is off unless somebody asks for it', () => {
    expect(previewingTheAppShell(fakeWindow(''))).toBe(false);
    expect(previewingTheAppShell(undefined)).toBe(false);
  });

  it('turns on with ?app=1 and is remembered', () => {
    const win = fakeWindow('?app=1');
    expect(previewingTheAppShell(win)).toBe(true);
    // Sticky, or the first link followed drops back to the website.
    expect(win.read()).toBe('1');
    expect(previewingTheAppShell(fakeWindow('', '1'))).toBe(true);
  });

  it('turns off with ?app=0, and forgets', () => {
    const win = fakeWindow('?app=0', '1');
    expect(previewingTheAppShell(win)).toBe(false);
    expect(win.read(), 'leaving preview must not come back on the next page').toBe(null);
  });

  it('ignores anything else in the query string', () => {
    expect(previewingTheAppShell(fakeWindow('?dial=1&app=yes'))).toBe(false);
    expect(previewingTheAppShell(fakeWindow('?view=table'))).toBe(false);
  });

  it('survives storage that throws, answering for this page alone', () => {
    // Private windows and blocked site data throw on read and on write.
    const hostile = {
      location: { search: '?app=1' },
      localStorage: {
        getItem: () => { throw new Error('blocked'); },
        setItem: () => { throw new Error('blocked'); },
        removeItem: () => { throw new Error('blocked'); },
      },
    };
    expect(previewingTheAppShell(hostile)).toBe(true);
    expect(previewingTheAppShell({ ...hostile, location: { search: '' } })).toBe(false);
  });
});
