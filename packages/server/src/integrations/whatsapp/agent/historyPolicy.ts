/**
 * What a linked phone is allowed to bring into the CRM.
 *
 * This is the rule the last two attempts did not have, and it is why both had
 * to be torn out. Pointed at a real handset, a linked session offers the CRM
 * everything on that phone — the rep's mother, their landlord, their doctor.
 * Migration 060's connector took all 821 of them. Scoping them per user hid
 * them from colleagues and they were still there.
 *
 * So the question is never "did WhatsApp give us this conversation" but "does
 * this number belong to somebody the business already deals with". A number the
 * CRM has never heard of is not stored, not indexed, not shown, and not
 * summarised. It is simply not ours.
 *
 * Two shapes of traffic go through here and they are not the same:
 *
 *   * **History**, which arrives in one batch during the handshake after a scan
 *     and can never be asked for again. Strictly known contacts: this is where
 *     the private life lives.
 *   * **A live message**, which is somebody messaging this number right now. An
 *     unknown number here is a lead, not a leak — the rep is being contacted
 *     through a business account they linked on purpose. It is held for the rep
 *     to name, and never filed against a contact on a guess.
 */

export type HistoryScope = 'known_contacts';

export type MessageArrival = 'history' | 'live';

export type PolicyOutcome =
  /** Store it and attach it to the contact we matched. */
  | { store: true; attachTo: string; reason: 'known_contact' }
  /** Store it as an unmatched conversation somebody must claim or dismiss. */
  | { store: true; attachTo: null; reason: 'live_unknown_number' }
  /** Do not store it, do not log its content, do not count it. */
  | { store: false; reason: 'history_from_unknown_number' | 'no_handle' };

export interface PolicyInput {
  /** The other party's number, already normalised to E.164 by the caller. */
  handle: string | null | undefined;
  /** The CRM record this number matches, if any. */
  matchedRecordId: string | null;
  arrival: MessageArrival;
  scope: HistoryScope;
}

/**
 * The one decision, in one place.
 *
 * Deliberately pure and deliberately boring: no database, no clock, no socket.
 * Everything that reaches the CRM from a linked phone passes through this, so it
 * has to be the easiest function in the system to read and to test.
 */
export function decide(input: PolicyInput): PolicyOutcome {
  // A message with no sender is not a message we can attribute to anybody, and
  // an unattributable message in a shared CRM is worse than no message.
  if (!input.handle || !input.handle.trim()) {
    return { store: false, reason: 'no_handle' };
  }

  if (input.matchedRecordId) {
    return { store: true, attachTo: input.matchedRecordId, reason: 'known_contact' };
  }

  // Unknown, and from the past. This is the rep's own life, and the whole reason
  // this file exists.
  if (input.arrival === 'history') {
    return { store: false, reason: 'history_from_unknown_number' };
  }

  // Unknown, and happening now. Somebody is contacting the business; that is
  // work, not private correspondence. It waits to be claimed.
  return { store: true, attachTo: null, reason: 'live_unknown_number' };
}

/**
 * Whether a whole conversation may be pulled in during the post-scan handshake.
 *
 * Asked once per conversation before any of its messages are read, so an
 * unknown chat is never in memory long enough to be logged by accident.
 */
export function mayImportConversation(
  handle: string | null | undefined,
  matchedRecordId: string | null,
  scope: HistoryScope,
): boolean {
  return decide({ handle, matchedRecordId, arrival: 'history', scope }).store;
}
