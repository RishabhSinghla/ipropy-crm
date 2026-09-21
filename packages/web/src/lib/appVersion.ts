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
 * The builds signed with a **different** key from the one shipping now.
 *
 * Android refuses an update signed by a different key from the one already on
 * the phone: it answers *"App not installed"* and says nothing about why. This
 * app has been signed by two keys, and **the published build is back on the
 * original one** — read out of the APKs themselves with
 * `packages/app/scripts/which-key-signed-it.py`, never assumed:
 *
 *   1.0.0  `A2:55:AD:0D…`  the original key, 12 Sep
 *   2.0.0  `D6:CD:55:3B…`  a second key made on 20 Sep, on another machine
 *   2.1.0  `D6:CD:55:3B…`  the same second key
 *   2.2.0  `A2:55:AD:0D…`  **the original again** — built 21 Sep from the key
 *                          its owner shared into the repository's secrets
 *
 * So the odd ones out are 2.0.0 and 2.1.0, and everything else updates in
 * place. **This was the other way round for half an hour on 21 September**,
 * written before 2.2.0 existed and on the reasonable assumption that a new
 * key, once adopted, is the one that stays. It was not: the two developers
 * hold different keys and whichever one builds decides. Hence the list rather
 * than a boundary — a "newer than X" rule cannot express a key that comes
 * back.
 */
const OTHER_KEY_BUILDS = ['2.0.0', '2.1.0'];

/**
 * Does this phone have to uninstall before it can take the published build?
 *
 * **An unknown version counts as yes.** A build too old to name itself cannot
 * be checked against the list, and being told to uninstall when you need not
 * costs one extra tap — while not being told costs a flat refusal from Android
 * and a rep who reports the app as broken.
 */
export function needsUninstallFirst(installed: string | null | undefined): boolean {
  const have = parts(installed);
  if (!have.length) return true;
  return OTHER_KEY_BUILDS.some((build) => {
    const other = parts(build);
    return other.length === have.length && other.every((n, i) => n === have[i]);
  });
}
