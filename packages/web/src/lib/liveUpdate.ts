/**
 * The app's screens, kept in step with the server, without reinstalling it.
 *
 * The app runs the same React bundle this CRM serves to browsers — but the
 * copy inside the installed binary was frozen the day it was built. So a
 * wording change, a new field on a screen, a fixed button all reached
 * crm.ipropy.com immediately and reached the phones never, until somebody
 * built an APK and asked a team of people to install it again.
 *
 * This closes that. On launch the app asks the server what it is serving; if
 * that is not what the app is running, it fetches it quietly in the background
 * and uses it from the next launch. Nobody waits, nobody installs anything.
 *
 * **What this cannot update is the native half** — plugins, permissions, the
 * call-log engine, the icon. Those live in the binary and still need a real
 * release. In practice they change rarely and the screens change constantly,
 * which is exactly the split that makes this worth having.
 *
 * Two safety properties worth stating, because both are load-bearing:
 *
 * - `notifyAppReady()` is called once React has painted. If a bundle fails to
 *   reach that point the plugin puts the previous one back on the next launch.
 *   A bad deploy therefore costs one restart, not a team of bricked phones.
 * - The new bundle is applied at the *next* launch, never mid-session. Swapping
 *   the page out from under somebody who is halfway through adding a lead is
 *   not an improvement.
 */
import { apiBase, isNative } from './native';

interface ServerBundle {
  available: boolean;
  version: string | null;
  url: string | null;
}

/**
 * Tell the plugin this bundle works.
 *
 * Must run on every launch, including the very first one on the bundle that
 * shipped inside the app. Miss it and the plugin assumes the bundle failed and
 * rolls back — which presents as an app that silently never updates.
 */
export async function markBundleHealthy(): Promise<void> {
  if (!isNative) return;
  try {
    const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
    await CapacitorUpdater.notifyAppReady();
  } catch { /* an older build with no updater in it is not an error */ }
}

/**
 * Fetch a newer set of screens if the server has one, and queue it for the
 * next launch.
 *
 * Deliberately quiet. Every failure here — no signal, an API-only server, a
 * half-downloaded zip — leaves the app exactly as it was, running the bundle
 * it already had. An update that cannot be fetched is not a problem the person
 * holding the phone can do anything about.
 */
export async function fetchUpdateInBackground(atLaunch = false): Promise<void> {
  if (!isNative) return;

  try {
    const { CapacitorUpdater } = await import('@capgo/capacitor-updater');

    const res = await fetch(`${apiBase()}/api/public/app/bundle`);
    if (!res.ok) return;
    const server = await res.json() as ServerBundle;
    if (!server.available || !server.version || !server.url) return;

    const current = await CapacitorUpdater.current();
    if (current.bundle.version === server.version) return;

    /*
      Already downloaded on an earlier launch? Then switch to it now.

      `set` reloads the webview, which is why this only ever happens moments
      after launch — nobody is halfway through anything yet, so the reload is
      invisible. Doing it on resume instead would take the screen away from
      somebody mid-sentence in a note.

      `next()` was tried first and is the more obviously correct API — queue it,
      let the next cold start pick it up. On Android it does not: the bundle is
      queued, the app is force-stopped and relaunched, and it comes back on the
      built-in one. Measured, twice. So the rule here is download quietly on one
      launch, switch on the following one.
    */
    const { bundles } = await CapacitorUpdater.list();
    const waiting = bundles.find((b) => b.version === server.version);
    if (waiting) {
      if (atLaunch) await CapacitorUpdater.set({ id: waiting.id });
      return;
    }

    const downloaded = await CapacitorUpdater.download({
      // Absolute: the app's own origin serves nothing, so a relative path here
      // resolves to the bundle it is already running.
      url: `${apiBase()}${server.url}`,
      version: server.version,
    });
    /*
      Applied now if the app has just started, queued if it has not.

      Queuing in both cases was the first design and it is subtly wrong: a rep
      who opens the app once a day and closes it would be one deploy behind for
      ever, because the bundle fetched on Monday is only used on Tuesday. So a
      launch downloads *and* switches — a reload a second or two in, on the
      login or the list, where nobody has started anything yet.

      A resume only downloads. Taking the screen away from somebody halfway
      through a note is not an improvement, and they will get it at their next
      launch.
    */
    if (atLaunch) await CapacitorUpdater.set({ id: downloaded.id });
    else await CapacitorUpdater.next({ id: downloaded.id }).catch(() => undefined);

    /*
      Housekeeping. Each bundle is a couple of megabytes on the device, and
      without this every deploy leaves one behind for ever. The one running and
      the one queued are kept; everything else has been superseded.
    */
    const after = await CapacitorUpdater.list();
    for (const old of after.bundles) {
      if (old.version === server.version || old.id === current.bundle.id) continue;
      await CapacitorUpdater.delete({ id: old.id }).catch(() => undefined);
    }
  } catch { /* see the note above: silence is the right answer here */ }
}
