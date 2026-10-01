/**
 * "Rewrite with AI" on the notes box: what a rep typed, said a little better.
 *
 * The owner, 3 October 2026: *"so it write nicely not at all very professional
 * way but nice way whatever user writes in the box whether in hindi/English/
 * hinglish"*. So the model keeps the rep's own language and their own voice; it
 * fixes the spelling, the run-on sentence and the missing full stop, and it does
 * not turn "client ko 3bhk pasand aaya" into a paragraph of corporate English.
 *
 * Nothing is saved. The rewrite goes back to the box for the rep to read, and
 * they post it or not — the same rule as voice notes.
 *
 * With no AI provider, the note still comes back tidied by a plain rule
 * (`tidyNote`), and the answer says the model did not run, so the screen can
 * say so rather than pretending a model rewrote it.
 */
import { aiStatus, complete } from './client.js';
import { toLatin } from './devanagari.js';

/** Plain tidy with no model: spaces, capital letters, a full stop. */
export function tidyNote(text: string): string {
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').replace(/\s+([,.!?])/g, '$1').trim());
  const tidied = lines.map((line) => {
    if (!line) return line;
    const capitalised = line.replace(/(^|[.!?]\s+)([a-z])/g, (_match, before: string, letter: string) => before + letter.toUpperCase());
    return capitalised.replace(/\bi\b/g, 'I');
  });
  const joined = tidied.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!joined) return joined;
  return /[.!?)…:]$/.test(joined) ? joined : `${joined}.`;
}

/*
  One rewrite, and it is the fuller one. The owner, 1 October 2026: Polish,
  Shorter and More detail were three answers to choose between, and he wants
  only More detail — a note a colleague can pick up and act on.
*/
const ASK = 'Make it fuller and easier for a colleague to act on: spell out shorthand '
  + '("cl bk tmrw" becomes "call back tomorrow", "bdgt 1.2cr" becomes "budget 1.2 Cr"), give each fact '
  + 'its own line, and make clear what happened and what was agreed — but only from what the note says.';

export interface RewriteAnswer {
  note: string;
  /** A model wrote it; false means the plain tidy below. */
  rewritten: boolean;
  /** Why no model wrote it, so the screen can say the true thing. */
  reason?: 'no_ai' | 'no_answer' | 'switched_off';
}

/*
  The provider's quick model, on purpose. Measured on production, 1 October
  2026: Gemini Flash-Lite answered notes in about 1.4 seconds, the writing
  model (Admin → AI models → copy) in about 6 and up to 10 — and a button a
  rep presses mid-conversation has to come back while they are still looking.
*/
export async function rewriteNote(text: string, userId: string): Promise<RewriteAnswer> {
  if (!aiStatus().available) return { note: tidyNote(text), rewritten: false, reason: 'no_ai' };
  const answer = await complete({
    feature: 'note_rewrite',
    fast: true,
    system: 'You rewrite notes a property sales team leaves on a customer record. '
      + 'You keep the language the note was written in: English stays English, Hindi stays Hindi, '
      + 'Hinglish stays Hinglish in Latin script. You never translate. You never add a fact, a number, '
      + 'a name or a next step that is not in the note. You sound like a friendly, capable colleague, '
      + 'never corporate.',
    prompt: `Rewrite this note.\n\n"""${text.slice(0, 4_000)}"""\n\n`
      + `${ASK}\n`
      + '- Fix spelling, grammar and punctuation.\n'
      + '- Keep every number, name, date and amount exactly as written.\n'
      + '- No greeting, no heading, no sign-off, no quotes around it. Keep any emoji or @mention it already has.\n\n'
      + 'Return only the rewritten note.',
    maxTokens: 600,
    // A little variety, so "Try again" can offer a different wording.
    temperature: 0.6,
    userId,
  });
  const written = answer?.text.trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
  if (written) return { note: toLatinIfHinglish(text, written), rewritten: true };
  return { note: tidyNote(text), rewritten: false, reason: 'no_answer' };
}

/*
  A note typed in Latin script comes back in Latin script. Models sometimes
  answer a Hinglish note in Devanagari, which the team does not read; a note
  that was typed in Devanagari is left alone, because that was the writer's
  choice.
*/
function toLatinIfHinglish(original: string, written: string): string {
  const typedInDevanagari = /[ऀ-ॿ]/.test(original);
  return typedInDevanagari ? written : toLatin(written);
}
