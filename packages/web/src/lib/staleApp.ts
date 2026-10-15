/*
  When the browser is running an old or damaged copy of the app.

  Every deploy renames the app's script files. A browser (or its service worker)
  holding a copy from before the deploy, or a damaged one, then asks for a file it
  cannot get and the screen fails with "Failed to fetch dynamically imported
  module". It used to stay broken until somebody hard-refreshed. Now the app does
  the cleaning itself: it forgets its saved copies and reloads, once.

  "Once a minute" and not "once ever" or "every time", so a real outage cannot
  turn into a loop of reloads.
*/
const LOOKS_STALE = /dynamically imported module|Importing a module script failed|Loading chunk [\w-]+ failed|Unable to preload CSS/i;

export const RECOVERED_AT_KEY = 'ipropy.staleAppRecoveredAt';
export const RECOVER_AT_MOST_EVERY_MS = 60_000;

export function isStaleAppError(message: string): boolean {
  return LOOKS_STALE.test(message);
}

export function mayRecoverNow(lastRecoveredAt: number | null, now: number): boolean {
  return lastRecoveredAt === null || now - lastRecoveredAt >= RECOVER_AT_MOST_EVERY_MS;
}

/** Forgets the saved copies and reloads. Answers true when a reload has been started. */
export async function recoverFromStaleApp(message: string): Promise<boolean> {
  if (!isStaleAppError(message)) return false;
  try {
    const saved = window.sessionStorage.getItem(RECOVERED_AT_KEY);
    const last = saved === null ? null : Number(saved);
    if (!mayRecoverNow(Number.isFinite(last) ? last : null, Date.now())) return false;
    window.sessionStorage.setItem(RECOVERED_AT_KEY, String(Date.now()));

    const workers = await navigator.serviceWorker?.getRegistrations?.() ?? [];
    await Promise.all(workers.map((worker) => worker.unregister()));
    const names = await window.caches?.keys?.() ?? [];
    await Promise.all(names.map((name) => window.caches.delete(name)));
    window.location.reload();
    return true;
  } catch {
    return false;
  }
}
