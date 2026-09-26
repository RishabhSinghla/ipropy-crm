/**
 * The phone collecting a call the CRM asked it to place.
 *
 * **20 September 2026, the owner:** *"the connection between mobile and web
 * CRM not working"* — pressing Call at a desk, and the handset never ringing.
 *
 * The instruction is a row the server queues for ninety seconds. Until now the
 * only things that made a phone go and look for it were a socket event, a
 * socket *reconnect*, and the app resuming. All three are the same bet: that
 * the app's realtime connection is up. When it is not — no signal for a
 * minute, a webview the OS froze, a server restart mid-session — nothing ever
 * looked, the row expired, and the desk reported that the phone did not pick
 * it up. Which was true, and said nothing about why.
 *
 * So the phone also just looks, on a timer, while the app is open. Five
 * seconds against a ninety-second instruction is a dozen chances to catch it
 * with no socket involved at all.
 *
 * **Two of these cannot double-ring**, which is what makes belt and braces
 * safe here: `/dial/pending` claims the row as it hands it over — one
 * statement, `FOR UPDATE SKIP LOCKED` — so the socket path and this timer
 * cannot both be given the same call.
 */
import { api } from './api';
import { callSyncSupported, endCallOnPhone, performCallAction, placeCallFromPhone } from './callSync';
import { isNative } from './native';
import { dial } from './nativeActions';

/** Often enough to feel immediate against a command that lives 90 seconds. */
const EVERY_MS = 5_000;

let busy = false;
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Ask whether anything is waiting, and place it.
 *
 * Exported because the socket path calls it too: one definition of "collect
 * the call", so the two routes cannot start behaving differently.
 */
export async function takePendingDial(): Promise<void> {
  if (!isNative || busy) return;
  busy = true;
  try {
    const { command } = await api.pendingDial();
    if (!command) return;

    /*
      Hanging up is the same road as ringing, and deliberately: one queue, one
      claim, one place a command is handed over exactly once. It carries no
      number — the phone ends whatever call it is on — and it lives twenty
      seconds rather than ninety, because a late hang-up would cut off the
      *next* conversation and there is no undoing that.
    */
    /*
      Speaker, mute or hold from the desk. The phone's own call service also
      collects these every second while a call is up, and whichever asks first
      is given it — the claim is atomic — so this path only matters when the
      app happens to be open.
    */
    if (command.kind === 'control' && command.action) {
      await performCallAction(command.action, command.on !== false, command.id);
      return;
    }

    if (command.kind === 'hangup') {
      const ended = await endCallOnPhone(command.id);
      if (!ended.ended) {
        await api.closeDial(command.id, { ok: false, error: ended.reason ?? 'could not end the call' })
          .catch(() => undefined);
      }
      return;
    }

    if (!command.number) return;
    const placed = callSyncSupported
      ? await placeCallFromPhone(command.number, command.id)
      : { placed: false, reason: 'not-android' };
    if (placed.placed) return;

    /*
      An installed build with no native caller in it — which is most of them —
      can still hand the number to the phone's own dialler, with the digits
      already in. The rep presses the green button. Reported as `dialler` so
      the desk says "press the green button" rather than claiming it rang.
    */
    dial(command.number);
    await api.closeDial(command.id, { ok: true, via: 'dialler' }).catch(() => undefined);
  } catch {
    // No signal, a token being refreshed, a server restart. The next tick
    // asks again, and the desk still has its own fallback.
  } finally {
    busy = false;
  }
}

/** Starts the watch in the app, and does nothing at all in a browser. */
export function startDialWatch(): void {
  if (!isNative || timer) return;
  const look = (): void => {
    // A backgrounded app is not one somebody is about to be called from, and
    // polling from it would spend battery for nothing.
    if (document.visibilityState === 'visible') void takePendingDial();
  };
  look();
  timer = setInterval(look, EVERY_MS);
  document.addEventListener('visibilitychange', look);
}
