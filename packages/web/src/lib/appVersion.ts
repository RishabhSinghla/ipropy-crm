/**
 * What this phone is running, and whether it is behind.
 *
 * The app has two halves and they update by different routes, which is exactly
 * why "the app is not working" has been impossible to answer:
 *
 *  * **The screens** are the same React bundle the website serves. They update
 *    themselves — the app asks the server what it is serving and swaps to it on
 *    the next launch — so they are almost always current.
 *  * **The native half** — the dialler, the call-log reader, the permissions —
 *    is frozen in the installed APK and only changes when somebody installs a
 *    new one. This is the half that has been out of date on every handset in
 *    the business since `placeCall` was written.
 *
 * A rep holding the phone could see neither. `callSyncStatus()` has carried the
 * installed version all along and nothing ever showed it.
 */

/** `2.1.0` → `[2, 1, 0]`, and anything unparseable → `[]`, which is "unknown". */
function parts(version: string | null | undefined): number[] {
  if (!version) return [];
  const cleaned = version.trim().replace(/^v/i, '');
  if (!/^\d+(\.\d+)*$/.test(cleaned)) return [];
  return cleaned.split('.').map((n) => Number(n));
}

/**
 * Is `published` newer than `installed`?
 *
 * **An unknown installed version counts as behind**, and that is the important
 * case rather than an edge one: a build old enough to have no version to report
 * is, by definition, older than the one on offer. Answering "no update needed"
 * there would hide the exact phones that need one.
 *
 * Compared number by number rather than as text, because `2.10.0` is newer than
 * `2.9.0` and sorts before it as a string.
 */
export function updateAvailable(installed: string | null | undefined, published: string | null | undefined): boolean {
  const have = parts(installed);
  const offered = parts(published);
  if (!offered.length) return false;      // nothing published, nothing to offer
  if (!have.length) return true;          // too old to say, so: behind
  for (let i = 0; i < Math.max(have.length, offered.length); i += 1) {
    const a = have[i] ?? 0;
    const b = offered[i] ?? 0;
    if (a !== b) return b > a;
  }
  return false;
}

/** What to call a version nobody can read off the phone. */
export const UNKNOWN_VERSION = 'an older build';

/**
 * The last build signed with the **old** key.
 *
 * Android refuses an update signed by a different key from the one already on
 * the phone: it answers *"App not installed"* and says nothing about why. A new
 * signing key was generated on 20 September 2026, so there is exactly one such
 * boundary in this app's history, read out of the published APKs themselves
 * with `packages/app/scripts/which-key-signed-it.py` rather than assumed:
 *
 *   1.0.0  `A2:55:AD:0D…`  key made 12 Sep 05:37 GMT
 *   2.0.0  `D6:CD:55:3B…`  key made 20 Sep 11:07 GMT
 *   2.1.0  `D6:CD:55:3B…`  the same key
 *
 * So a phone on 1.0.0 must uninstall before it can install anything newer, and
 * a phone on 2.0.0 or later updates over the top as usual. Until this existed
 * both screens told every rep the new build installs over the top, which is
 * true for one phone in the business and false for the three that need it.
 */
const LAST_OLD_KEY_BUILD = '1.0.0';

/**
 * Does this phone have to uninstall before it can take a new build?
 *
 * **An unknown version counts as yes**, for the same reason `updateAvailable`
 * counts it as behind: a build too old to name itself is older than 1.0.0, so
 * it is on the old key or on no key anybody has a record of. Being told to
 * uninstall when you did not need to costs one extra tap; not being told costs
 * a flat refusal from Android and a rep who reports the app as broken.
 */
export function needsUninstallFirst(installed: string | null | undefined): boolean {
  const have = parts(installed);
  if (!have.length) return true;
  const boundary = parts(LAST_OLD_KEY_BUILD);
  for (let i = 0; i < Math.max(have.length, boundary.length); i += 1) {
    const a = have[i] ?? 0;
    const b = boundary[i] ?? 0;
    if (a !== b) return a < b;   // newer than the boundary → installs over the top
  }
  return true;                   // exactly the boundary build → the old key
}
