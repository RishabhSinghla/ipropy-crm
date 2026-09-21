/**
 * Which phones have to uninstall before they can update.
 *
 * Two developers hold two different signing keys, and whichever one builds
 * decides. 1.0.0 and 2.2.0 are on the original; 2.0.0 and 2.1.0 are on a
 * second key made on another machine. Android refuses an update signed by a
 * different key than what is installed — *"App not installed"*, and nothing
 * else — so the answer is a list of the odd ones out, not a version boundary.
 */
import { describe, expect, it } from 'vitest';
import { needsUninstallFirst, updateAvailable } from '../src/lib/appVersion';

describe('crossing a signing-key change', () => {
  it('1.0.0 updates in place, because 2.2.0 is on the same original key', () => {
    expect(needsUninstallFirst('1.0.0')).toBe(false);
  });

  it('2.0.0 and 2.1.0 must uninstall — they are the odd ones out', () => {
    expect(needsUninstallFirst('2.0.0')).toBe(true);
    expect(needsUninstallFirst('2.1.0')).toBe(true);
  });

  it('the build being shipped never asks for an uninstall of itself', () => {
    expect(needsUninstallFirst('2.2.0')).toBe(false);
  });

  it('a build too old to name itself counts as needing it', () => {
    expect(needsUninstallFirst(null)).toBe(true);
    expect(needsUninstallFirst('')).toBe(true);
    expect(needsUninstallFirst('nightly')).toBe(true);
  });

  it('is a separate question from whether there is an update at all', () => {
    // 1.0.0 is behind and needs no uninstall; 2.1.0 is behind and does.
    expect(updateAvailable('1.0.0', '2.2.0')).toBe(true);
    expect(needsUninstallFirst('1.0.0')).toBe(false);
    expect(updateAvailable('2.1.0', '2.2.0')).toBe(true);
    expect(needsUninstallFirst('2.1.0')).toBe(true);
  });
});
