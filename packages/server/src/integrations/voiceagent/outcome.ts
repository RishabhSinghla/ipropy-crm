/**
 * What an AI call actually was, read from what was said.
 *
 * Read off production on 20 October 2026: of 76 AI calls Sarvam called "completed", 30 were real
 * conversations, 22 were somebody picking up and saying nothing, 21 were one or two words, and 3 were
 * voicemail. All 76 had a transcript and none had a disposition, so a rep opening the list could not tell a
 * buyer who gave a budget from a phone that rang in a pocket.
 *
 * This is the deterministic half (CLAUDE.md rule 7: AI degrades, it never blocks). It decides from the
 * customer's own words, never from the agent's, and it is deliberately cautious: a call it cannot place stays
 * `conversation`, and a customer who stayed for more than three turns gave the agent something worth reading whatever one
 * word they used to end it, and the optional AI analysis that runs afterwards adds the nuance.
 */

export type SarvamOutcomeKind =
  | 'silent' | 'voicemail' | 'wrong_number' | 'stop_calling' | 'not_interested' | 'already_bought' | 'callback' | 'conversation';

export interface SarvamOutcome {
  kind: SarvamOutcomeKind;
  /** One line a rep can read at a glance. */
  label: string;
  /** The customer asked not to be rung again: record it, and never dial them. */
  stopCalling: boolean;
  /** A real two-way conversation, as opposed to a pick-up. */
  spoke: boolean;
}

/** The customer's lines only: the agent's greeting says "am I speaking with…" and must never decide an outcome. */
export function customerWords(transcript: string | null): string {
  if (!transcript) return '';
  return transcript.split('\n')
    .filter((line) => /^customer:/i.test(line.trim()))
    .map((line) => line.replace(/^customer:\s*/i, '').trim())
    .filter(Boolean)
    .join(' \n ');
}

const VOICEMAIL = /record your message|voice ?mail|after the (beep|tone)|leave (a|your) message|not (available|reachable)|switched off|out of (coverage|reach|service)|cannot be (reached|taken|connected)|currently (busy|unavailable)|please try again later|the number you (have )?dial/i;
const STOP = /(do not|don'?t|dont|never|stop) (call|ring|phone|contact|disturb)( me| us)?( again| anymore| any more)?|no more calls|remove (my|this) (number|name)|take (me|my number) off|stop calling|do not disturb|\bndnc\b|\bdnd\b/i;
const WRONG = /wrong (number|person)|(you have|you've) (the )?wrong|no (one|body) (by|with) that name|there is no .{0,30} here|\bnot (him|her|that person)\b|i am not (mr|mrs|ms|shri|the person)\b/i;
const ALREADY = /already (bought|purchased|booked|taken|finalised|finalized|got|have)|have (bought|purchased|booked) (one|a|the)|deal (is )?(done|final)/i;
const NOT_INTERESTED = /not (interested|looking|planning|required|needed)|no (need|interest|requirement)|don'?t (need|want|require)|do not (need|want|require)|not now|no thanks?|no thank you/i;
const CALLBACK = /call (me )?(back|again|later|tomorrow|tonight|in the evening|after)|(later|tomorrow|evening|next week|in an hour)|busy (right )?now|not (a )?good time|in a meeting|i am driving|i'?m driving|(talk|speak|call) (to )?me (later|tomorrow)|ring me/i;

/** Words a person says when they stay on the line; a lone "hello" or "yes" is not a conversation. */
const REAL_TURNS = 2;

export function readSarvamOutcome(input: { status: string; transcript: string | null; durationSeconds: number }): SarvamOutcome | null {
  if (input.status !== 'connected' && input.status !== 'completed') return null;
  const said = customerWords(input.transcript);
  const turns = said ? said.split('\n').filter((line) => line.trim()).length : 0;
  if (!said) return { kind: 'silent', label: 'Answered, but the customer said nothing', stopCalling: false, spoke: false };
  if (VOICEMAIL.test(said) && turns <= 2) return { kind: 'voicemail', label: 'Voicemail or an operator message', stopCalling: false, spoke: false };
  if (STOP.test(said)) return { kind: 'stop_calling', label: 'Asked not to be called again', stopCalling: true, spoke: true };
  if (WRONG.test(said) && turns <= 3) return { kind: 'wrong_number', label: 'Wrong number or wrong person', stopCalling: false, spoke: true };
  if (ALREADY.test(said)) return { kind: 'already_bought', label: 'Has already bought', stopCalling: false, spoke: true };
  if (NOT_INTERESTED.test(said) && turns <= 3) return { kind: 'not_interested', label: 'Not interested', stopCalling: false, spoke: true };
  if (CALLBACK.test(said) && turns <= 3) return { kind: 'callback', label: 'Asked to be called back', stopCalling: false, spoke: true };
  return { kind: 'conversation', label: turns >= REAL_TURNS ? 'Had a conversation' : 'Answered briefly', stopCalling: false, spoke: turns >= REAL_TURNS };
}

/** What each outcome is called in the CRM's own "call disposition" dropdown, best name first. An admin may rename them. */
const WANTED: Record<SarvamOutcomeKind, string[]> = {
  silent: ['not reachable', 'switch off'],
  voicemail: ['not reachable', 'switch off'],
  wrong_number: ['invalid/wrong num', 'wrong number', 'invalid'],
  stop_calling: ['not interested', 'do not call'],
  not_interested: ['not interested'],
  already_bought: ['already purchased', 'not interested'],
  callback: ['call back request', 'call back later', 'callback'],
  conversation: ['call connected', 'connected', 'interested'],
};

const plain = (value: string): string => value.toLocaleLowerCase().replace(/[^a-z0-9]/g, '');

/** The CRM option for an outcome, or null when the dropdown has nothing that fits: a made-up value would fail validation. */
export function dispositionFor(kind: SarvamOutcomeKind, options: string[]): string | null {
  for (const name of WANTED[kind]) {
    const wanted = plain(name);
    const hit = options.find((option) => plain(option) === wanted) ?? options.find((option) => plain(option).includes(wanted));
    if (hit) return hit;
  }
  return null;
}

/** A line for the call's summary when no AI model is available to write one. */
export function ruleSummary(outcome: SarvamOutcome, input: { transcript: string | null; durationSeconds: number }): string {
  const minutes = input.durationSeconds >= 60 ? `${Math.round(input.durationSeconds / 60)} min` : `${input.durationSeconds}s`;
  const quote = customerWords(input.transcript).split('\n').map((line) => line.trim()).filter((line) => line.length > 3).slice(0, 2).join(' · ');
  return `AI call, ${minutes}. ${outcome.label}.${quote ? ` Customer: ${quote.slice(0, 220)}` : ''}`;
}

/** Sarvam names the telephony provider's reason ("exotel: Phone number is registered under TRAI NDNC"). */
export function isDoNotDisturbFailure(reason: string | null | undefined): boolean {
  return Boolean(reason && /\bndnc\b|\bdnd\b|do not disturb|do-not-disturb|blocked by (the )?(customer|operator)/i.test(reason));
}
