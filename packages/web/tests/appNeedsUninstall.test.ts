/**
 * Which phones have to uninstall before they can update.
 *
 * A new signing key was generated on 20 September 2026 and Android refuses an
 * update signed by a different key than the build already installed — it says
 * *"App not installed"* and nothing else. Both of the CRM's own screens told
 * every rep the new build installs "over the top", which was true for the one
 * handset already on 2.1.0 and false for the three that needed it.
 */
import { describe, expect, it } from 'vitest';
import { needsUninstallFirst, updateAvailable } from '../src/lib/appVersion';

describe('crossing the signing-key boundary', () => {
  it('1.0.0 has to uninstall, because it is on the old key', () => {
    expect(needsUninstallFirst('1.0.0')).toBe(true);
  });

  it('2.0.0 and later install over the top', () => {
    // Read off the published APKs: 2.0.0 and 2.1.0 share one key.
    expect(needsUninstallFirst('2.0.0')).toBe(false);
    expect(needsUninstallFirst('2.1.0')).toBe(false);
    expect(needsUninstallFirst('2.2.0')).toBe(false);
    expect(needsUninstallFirst('10.0.0')).toBe(false);
  });

  it('a build too old to name itself counts as needing it', () => {
    // Being told to uninstall when you need not costs a tap. Not being told
    // costs a flat refusal nobody can interpret.
    expect(needsUninstallFirst(null)).toBe(true);
    expect(needsUninstallFirst('')).toBe(true);
    expect(needsUninstallFirst('nightly')).toBe(true);
  });

  it('is a separate question from whether there is an update at all', () => {
    // 2.1.0 is current and still needed no uninstall; the two must not be
    // read off one another.
    expect(updateAvailable('2.1.0', '2.1.0')).toBe(false);
    expect(needsUninstallFirst('2.1.0')).toBe(false);
    expect(updateAvailable('1.0.0', '2.2.0')).toBe(true);
    expect(needsUninstallFirst('1.0.0')).toBe(true);
  });
});
