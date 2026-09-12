/**
 * Whether the CRM is showing its app screens or its website.
 *
 * This decides which of two entire layouts a person sees, and the branch that
 * matters only ever runs on somebody's phone — so it is the kind of code that
 * is wrong for weeks before anybody says anything. An iPhone that was told to
 * "install the app" and got the desktop list, with checkboxes and "Rows per
 * page 25", would be the whole point missed.
 */
import { describe, expect, it } from 'vitest';
import { launchedFromAHomeScreen } from '../src/lib/native';

const standalone = (matches: boolean) => ({ matchMedia: () => ({ matches }) });

describe('launched from a home screen', () => {
  it('is true when the browser says the app is standalone', () => {
    expect(launchedFromAHomeScreen(standalone(true))).toBe(true);
  });

  it('is false in an ordinary tab', () => {
    expect(launchedFromAHomeScreen(standalone(false))).toBe(false);
  });

  /*
    Apple's own flag, from before the standard existed. Some Safari versions
    set only this, so an iPhone added to the Home Screen reports nothing at all
    through `display-mode` — which is exactly the case this whole feature is
    for, since Apple allows no other kind of install without a paid account.
  */
  it('trusts Safari’s older flag when the standard one says nothing', () => {
    expect(launchedFromAHomeScreen({
      matchMedia: () => ({ matches: false }),
      navigator: { standalone: true },
    })).toBe(true);
  });

  it('is false when Safari’s flag says it is a tab', () => {
    expect(launchedFromAHomeScreen({
      matchMedia: () => ({ matches: false }),
      navigator: { standalone: false },
    })).toBe(false);
  });

  /*
    Older browsers have no `matchMedia`, and there is no window at all while a
    bundle is being built. Neither is an installed app, and neither may throw —
    this runs before the first render, so an exception here is a blank screen.
  */
  it('does not throw when the browser cannot answer', () => {
    expect(launchedFromAHomeScreen(undefined)).toBe(false);
    expect(launchedFromAHomeScreen({})).toBe(false);
    expect(launchedFromAHomeScreen({ navigator: {} })).toBe(false);
  });
});
