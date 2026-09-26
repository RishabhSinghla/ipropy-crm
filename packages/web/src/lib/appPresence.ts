/**
 * Telling the CRM this phone's app is open.
 *
 * Pressing Call at a desk rings a rep's handset by sending the instruction
 * over the app's own connection. A closed app has no connection, so it cannot
 * be rung — and until now nothing anywhere showed that. A manager saw "your
 * phone did not pick that up" after the fact, which names the symptom and not
 * the cause.
 *
 * So the app says so while it is open, every minute, and the Phones screen can
 * state plainly whether a Call would reach each handset.
 *
 * Three things keep it cheap and honest:
 *
 *  * **Only in the app.** A browser tab is not a phone and must never stamp one.
 *  * **Only while visible.** A phone in a pocket with the app backgrounded is
 *    not reachable, and saying it is would be the same lie in a new place.
 *  * **Failure is silence.** No signal, a refused request, a server restart —
 *    the app keeps working exactly as before and the status simply ages.
 */
import { api } from './api';
import { callControlState } from './callSync';
import { isNative } from './native';

/** A minute: long enough to cost nothing, short enough that "open" means open. */
const EVERY_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;

async function announce(): Promise<void> {
  if (document.visibilityState !== 'visible') return;
  try {
    /*
      The same breath says whether this handset is its own phone app, which is
      what lets the desk draw End as a control rather than a promise. Android
      can take that role back from its own settings without telling anybody,
      so it is asked every minute rather than remembered.
    */
    const { canEndCall, canControlCall } = await callControlState();
    await api.appIsOpen({ canEndCall, canControlCall });
  } catch {
    // A status column is never worth a toast.
  }
}

/** Starts the heartbeat in the app, and does nothing at all in a browser. */
export function startAppPresence(): void {
  if (!isNative || timer) return;
  void announce();
  timer = setInterval(() => void announce(), EVERY_MS);
  // Coming back to the app should update it immediately rather than at the
  // top of the next minute — that is exactly when somebody is about to be
  // called.
  document.addEventListener('visibilitychange', () => void announce());
}
