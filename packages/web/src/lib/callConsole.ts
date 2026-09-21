/**
 * The call console's decisions, kept out of the screen that draws them.
 *
 * Pure on purpose: a `node` test cannot import a component without dragging
 * the store in with it, and the store reads `localStorage` as it is
 * constructed. What is worth testing here is which outcome card an admin's
 * picklist value gets, what the timer reads, and whether the console may
 * offer a control at all — none of which needs a DOM.
 */

/** How an outcome is drawn: the word under it, and the chip in its corner. */
export interface OutcomeCard {
  /** A key the screen maps to an icon. Never a component, so this stays pure. */
  icon: 'up' | 'clock' | 'noring' | 'unreachable' | 'drop' | 'invalid';
  /** What happens next, in the rep's words. */
  hint: string;
  /** The small chip in the card's corner. */
  chip: string;
  /** Outcomes that mean this person is not a buyer any more. */
  disqualifies?: boolean;
  /**
   * When to chase them, in hours from now.
   *
   * The chip in the card's corner is printed from this rather than written
   * beside it, so a card promising "in 2 hours" and a follow-up landing
   * tomorrow cannot happen. An outcome with no offset schedules nothing: a
   * rep who wants a date says so in the header, where it is editable.
   */
  followUpInHours?: number;
}

/*
  Keyed by the *stored* picklist value, because that is what a record holds and
  what the server checks a save against. An admin who adds an outcome of their
  own still gets a card — see `outcomeCard` — rather than a list that silently
  stops at six.
*/
const CARDS: Record<string, OutcomeCard> = {
  Interested: { icon: 'up', hint: 'High priority buyer', chip: 'Priority' },
  'Site Visit Scheduled': { icon: 'up', hint: 'Visit booked', chip: 'Booked' },
  'Call Back Later': { icon: 'clock', hint: 'Call later today', chip: 'In 2 hours', followUpInHours: 2 },
  Busy: { icon: 'clock', hint: 'Call later today', chip: 'In 2 hours', followUpInHours: 2 },
  'Not Reachable': { icon: 'unreachable', hint: 'Schedule re-dial', chip: 'Unreachable', followUpInHours: 24 },
  'Switched Off': { icon: 'unreachable', hint: 'Schedule re-dial', chip: 'Unreachable', followUpInHours: 24 },
  'Not Interested': { icon: 'drop', hint: 'Disqualified', chip: 'Drop', disqualifies: true },
  'Already Purchased': { icon: 'drop', hint: 'Bought elsewhere', chip: 'Drop', disqualifies: true },
  'Do Not Call': { icon: 'drop', hint: 'Never contact again', chip: 'Drop', disqualifies: true },
  'Wrong Number': { icon: 'invalid', hint: 'Update records', chip: 'Invalid', disqualifies: true },
  'Language Barrier': { icon: 'invalid', hint: 'Hand to a colleague', chip: 'Barrier' },
  'Budget Mismatch': { icon: 'drop', hint: 'Out of budget', chip: 'Mismatch' },
  'Location Mismatch': { icon: 'drop', hint: 'Wrong area', chip: 'Mismatch' },
  /*
    Not one of this CRM's own outcomes, and kept because an admin adding it is
    the obvious thing to do — the ringing-out case has no entry in the seeded
    list. `outcomeCard` reads an unfamiliar one by its words anyway; this
    spares that one the guess.
  */
  'No Answer': { icon: 'noring', hint: 'Retry later today', chip: 'No ring', followUpInHours: 4 },
};

/**
 * The card for one outcome.
 *
 * An outcome nobody has described still gets drawn, with the outcome's own
 * name as its hint. The alternative is a rep who cannot record what actually
 * happened because an admin added an outcome after this file was written,
 * which is the mistake `useCallDispositions` already exists to prevent.
 */
export function outcomeCard(value: string): OutcomeCard {
  const known = CARDS[value];
  if (known) return known;
  const lower = value.toLowerCase();
  if (/(wrong|invalid)/.test(lower)) return { icon: 'invalid', hint: 'Update records', chip: 'Invalid', disqualifies: true };
  if (/(not interested|lost|junk|drop)/.test(lower)) return { icon: 'drop', hint: 'Disqualified', chip: 'Drop', disqualifies: true };
  if (/(reach|off|unavailable)/.test(lower)) return { icon: 'unreachable', hint: 'Schedule re-dial', chip: 'Unreachable' };
  if (/(answer|ring)/.test(lower)) return { icon: 'noring', hint: 'Retry later today', chip: 'No ring' };
  if (/(later|busy|back)/.test(lower)) return { icon: 'clock', hint: 'Call later today', chip: 'In 2 hours', followUpInHours: 2 };
  return { icon: 'up', hint: value, chip: '' };
}

/** `02:10`, and `1:04:09` once a call runs past the hour. */
export function elapsedLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = total >= 3600 ? String(Math.floor(total / 60) % 60).padStart(2, '0') : String(Math.floor(total / 60));
  return total >= 3600 ? `${Math.floor(total / 3600)}:${minutes}:${seconds}` : `${minutes.padStart(2, '0')}:${seconds}`;
}

export type Intent = 'hot' | 'warm' | 'cold';
export const INTENTS: Intent[] = ['hot', 'warm', 'cold'];

/**
 * Whether the console may offer to end, mute or hold the call.
 *
 * It may not, and this is the honest half of the design rather than an
 * oversight. Android only lets the handset's **default phone app** touch a
 * call that is already running, and iPropy is a passenger: it hands a number
 * to the dialler and reads the call log afterwards. A red End button that
 * ends nothing is worse than no button, so the controls are drawn disabled
 * with the reason on them, and light up on their own the day the app can.
 */
export function mayControlLiveCall(capabilities?: { endCall?: boolean }): boolean {
  return capabilities?.endCall === true;
}

export const NO_LIVE_CONTROL_REASON =
  'Android only lets the phone’s own dialler end a call. Use the red button on the handset.';

/**
 * How long the duration saved with the call should be, in minutes.
 *
 * A call the rep timed on this screen is better evidence than a number typed
 * into a box, but never less than a minute: a thirty-second conversation
 * rounding to zero reads as "never spoke to them" on every report.
 */
export function minutesFrom(startedAt: number | null, now: number, typed: number): number {
  if (!startedAt) return Math.max(0, typed);
  return Math.max(1, typed, Math.round((now - startedAt) / 60_000));
}

/**
 * The date a saved outcome should chase them on, or null for "leave it alone".
 *
 * Never overwrites a date somebody has already chosen: the header lets a rep
 * pick one while the call is still running, and a card quietly replacing it
 * afterwards is how a site visit booked for Saturday becomes a call-back in
 * two hours.
 */
export function followUpFor(
  outcome: string, existing: string | null | undefined, now: Date,
): string | null {
  const hours = outcomeCard(outcome).followUpInHours;
  if (!hours) return null;
  const when = new Date(now.getTime() + hours * 3600_000);
  const iso = when.toISOString();
  if (!existing) return iso;
  // Something already in the future is somebody's decision; only a date that
  // has been and gone is replaced.
  return new Date(existing).getTime() > now.getTime() ? null : iso;
}
