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
  /**
   * One of the six a rep uses all day, which the design shows in a single
   * row. The other seven are a tap away rather than filling the screen —
   * thirteen cards is three rows and a scroll after every call.
   */
  primary?: boolean;
}

/*
  Keyed by the *stored* picklist value, because that is what a record holds and
  what the server checks a save against. An admin who adds an outcome of their
  own still gets a card — see `outcomeCard` — rather than a list that silently
  stops at six.
*/
const CARDS: Record<string, OutcomeCard> = {
  Interested: { icon: 'up', hint: 'High priority buyer', chip: 'Priority', primary: true },
  'Site Visit Scheduled': { icon: 'up', hint: 'Visit booked', chip: 'Booked' },
  'Call Back Later': { icon: 'clock', hint: 'Call later today', chip: 'In 2 hours', followUpInHours: 2, primary: true },
  Busy: { icon: 'clock', hint: 'Call later today', chip: 'In 2 hours', followUpInHours: 2, primary: true },
  'Not Reachable': { icon: 'unreachable', hint: 'Schedule re-dial', chip: 'Unreachable', followUpInHours: 24, primary: true },
  'Switched Off': { icon: 'unreachable', hint: 'Schedule re-dial', chip: 'Unreachable', followUpInHours: 24 },
  'Not Interested': { icon: 'drop', hint: 'Disqualified', chip: 'Drop', disqualifies: true, primary: true },
  'Already Purchased': { icon: 'drop', hint: 'Bought elsewhere', chip: 'Drop', disqualifies: true },
  'Do Not Call': { icon: 'drop', hint: 'Never contact again', chip: 'Drop', disqualifies: true },
  'Wrong Number': { icon: 'invalid', hint: 'Update records', chip: 'Invalid', disqualifies: true, primary: true },
  'Language Barrier': { icon: 'invalid', hint: 'Hand to a colleague', chip: 'Barrier' },
  'Budget Mismatch': { icon: 'drop', hint: 'Out of budget', chip: 'Mismatch' },
  'Location Mismatch': { icon: 'drop', hint: 'Wrong area', chip: 'Mismatch' },
  /*
    Not one of this CRM's own outcomes, and kept because an admin adding it is
    the obvious thing to do — the ringing-out case has no entry in the seeded
    list. `outcomeCard` reads an unfamiliar one by its words anyway; this
    spares that one the guess.
  */
  'No Answer': { icon: 'noring', hint: 'Retry later today', chip: 'No ring', followUpInHours: 4, primary: true },
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

/**
 * The outcomes to show first, and the ones behind "more".
 *
 * Six on one row is the design, and thirteen cards is three rows and a scroll
 * at the end of every call. The split is a flag on the card rather than a list
 * of names here, and **the chosen outcome is always in the first group** —
 * otherwise picking one from "more" makes it vanish from the screen that is
 * showing it as chosen.
 */
export function splitOutcomes(all: string[], chosen: string): { first: string[]; rest: string[] } {
  /*
    The six sit in the same order every time — good first, gone last — rather
    than in whatever order the picklist happens to be sorted in. A row a rep
    hits a hundred times a day should be muscle memory, and "Interested" moving
    because somebody renamed an option is how a mis-tap happens. The full list
    below keeps the admin's own order.
  */
  const rank = (value: string): number => {
    const card = outcomeCard(value);
    if (card.disqualifies) return 3;
    if (card.icon === 'unreachable' || card.icon === 'noring') return 2;
    if (card.icon === 'clock') return 1;
    return 0;
  };
  const first = all
    .filter((value) => outcomeCard(value).primary)
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 6);
  if (chosen && !first.includes(chosen)) {
    // The chosen one takes the last place rather than growing the row.
    first.splice(first.length - 1, 1, chosen);
  }
  return { first, rest: all.filter((value) => !first.includes(value)) };
}

/** What the phone last said about its call, as far as the deck needs to know. */
export interface PhoneCallReport {
  state: 'dialling' | 'ringing' | 'active' | 'held' | 'ended' | null;
  /** When they picked up, on this computer's clock; null before that. */
  connectedAt: number | null;
  talkedSeconds: number | null;
  /** When the phone last reported, on this computer's clock. */
  reportedAt: number | null;
}

/**
 * The words at the top of the call deck.
 *
 * **26 September 2026, the owner:** the timer *"only start once call
 * connected else it shows ringing."* Only the phone knows when the other side
 * picked up, and only once iPropy is its calling app — so the clock runs from
 * the phone's own "answered", never from the moment Call was pressed. A phone
 * that reports nothing about this call (not the calling app, or an older app)
 * gets "Calling on your phone" and no clock at all, rather than a clock
 * counting a call that may not have been answered.
 */
export function deckStatus(
  report: PhoneCallReport | null,
  call: { pressedAt: number; placing: boolean },
  now: number,
): { label: string; ticking: boolean } {
  if (call.placing) return { label: 'Calling…', ticking: false };
  // A report from before this call was pressed is about the last one.
  const aboutThisCall = report?.state && report.reportedAt !== null && report.reportedAt >= call.pressedAt - 5_000;
  if (!report || !aboutThisCall) return { label: 'Calling on your phone', ticking: false };
  switch (report.state) {
    case 'dialling':
    case 'ringing':
      return { label: 'Ringing…', ticking: false };
    case 'active':
      return { label: elapsedLabel(report.connectedAt ? now - report.connectedAt : 0), ticking: true };
    case 'held':
      return { label: `On hold · ${elapsedLabel(report.connectedAt ? now - report.connectedAt : 0)}`, ticking: true };
    case 'ended':
      return {
        label: report.talkedSeconds ? `Call ended · ${elapsedLabel(report.talkedSeconds * 1000)}` : 'Not answered',
        ticking: false,
      };
    default:
      return { label: 'Calling on your phone', ticking: false };
  }
}
