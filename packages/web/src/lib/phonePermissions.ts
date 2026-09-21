/**
 * What the app needs the phone to allow, and which of those are still missing.
 *
 * Android grants nothing at install time. Every permission is asked for later,
 * from inside the app, by the piece of code that needs it — so an APK can be
 * installed, signed into, and still be unable to ring anybody, with nothing on
 * screen saying why. That is exactly what has happened here: 130 dial
 * instructions were queued and not one ever reached a handset.
 *
 * So this is the checklist, in plain words, and it is deliberately pure: the
 * decision of what is still outstanding is data, testable in `node`, and the
 * screen only draws it. Importing a component into a test drags the store in
 * with it, and the store reads `localStorage` as it is constructed.
 */
import type { CallSyncStatus } from './callSync';

export type PhoneStep = 'pair' | 'callPhone' | 'callLog' | 'endCall' | 'alerts' | 'location';

export interface PhoneNeed {
  key: PhoneStep;
  /** What the rep is being asked to allow. */
  title: string;
  /** What stops working without it, in one sentence they can act on. */
  why: string;
  /** Calling does not work at all without these. The rest are worth having. */
  required: boolean;
}

/*
  Order matters: it is the order the phone will ask in. Pairing comes first
  because turning call logging on is what makes Android show the two call
  dialogs — asking for them before there is anything to use them for is a
  pop-up with no explanation in front of it.
*/
export const PHONE_NEEDS: PhoneNeed[] = [
  {
    key: 'pair',
    title: 'Turn on calling for this phone',
    why: 'Links this handset to your CRM account. Nothing below can be asked for until it is on.',
    required: true,
  },
  {
    key: 'callPhone',
    title: 'Phone',
    why: 'Lets the CRM on a computer ring a number through this handset when you press Call.',
    required: true,
  },
  {
    key: 'callLog',
    title: 'Call logs',
    why: 'Files the calls you make and take against the right contact, on their own.',
    required: true,
  },
  {
    key: 'endCall',
    title: 'End a call from the CRM',
    why: 'Lets you hang up from the computer. Your phone keeps its own dialler.',
    required: false,
  },
  {
    key: 'alerts',
    title: 'Notifications',
    why: 'Follow-ups and new leads reach you when the app is closed.',
    required: false,
  },
  {
    key: 'location',
    title: 'Location, all the time',
    why: 'Shows where the team is on the map. Only asked for if you switch it on.',
    required: false,
  },
];

export interface PhoneSetupInput {
  status: CallSyncStatus | null;
  /** The OS's answer about notifications, as `push.ts` reports it. */
  alerts: 'granted' | 'denied' | 'default' | 'unavailable';
}

/** True when that step is already allowed on this handset. */
export function stepIsDone(step: PhoneStep, input: PhoneSetupInput): boolean {
  const s = input.status;
  if (!s) return false;
  switch (step) {
    case 'pair': return s.paired;
    case 'callPhone': return s.callPhoneGranted;
    case 'callLog': return s.callLogGranted;
    case 'endCall': return s.canEndCall === true;
    case 'alerts': return input.alerts === 'granted';
    /*
      Background and not merely foreground. "While using the app" reads as
      granted everywhere and reports nothing once the screen goes off, which
      is a map that quietly stops moving rather than one that says it is off.
    */
    case 'location': return s.backgroundLocationGranted;
  }
}

/**
 * The checklist to show, in order.
 *
 * Location is listed only once somebody has switched it on. A permission
 * offered to a rep who never asked for it reads as the CRM wanting to follow
 * them home, and refusing it then makes the whole list look failed.
 */
export function phoneChecklist(input: PhoneSetupInput): Array<PhoneNeed & { done: boolean }> {
  return PHONE_NEEDS
    .filter((n) => n.key !== 'location' || input.status?.locationEnabled)
    .map((n) => ({ ...n, done: stepIsDone(n.key, input) }));
}

/** What is still missing and actually stops a call. Empty means calling works. */
export function blockingSteps(input: PhoneSetupInput): PhoneStep[] {
  return phoneChecklist(input).filter((n) => n.required && !n.done).map((n) => n.key);
}
