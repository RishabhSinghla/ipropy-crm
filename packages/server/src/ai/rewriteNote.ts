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
import { jobModel } from '../core/settings/aiModels.js';
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

/** How the rep wants it rewritten — the three choices other writing tools offer. */
export type RewriteStyle = 'polish' | 'shorter' | 'detailed';

const STYLE_ASK: Record<RewriteStyle, string> = {
  polish: 'Make it read well: complete, clear sentences. Turn shorthand into words '
    + '("cl bk tmrw" becomes "call back tomorrow", "bdgt 1.2cr" becomes "budget 1.2 Cr"). '
    + 'Put separate facts on separate lines when there are several.',
  shorter: 'Make it as short as it can be while keeping every fact: a few crisp lines, no filler words.',
  detailed: 'Make it fuller and easier for a colleague to act on: spell out shorthand, give each fact '
    + 'its own line, and make clear what happened and what was agreed — but only from what the note says.',
};

export interface RewriteAnswer {
  note: string;
  /** A model wrote it; false means the plain tidy below. */
  rewritten: boolean;
  /** Why no model wrote it, so the screen can say the true thing. */
  reason?: 'no_ai' | 'no_answer' | 'switched_off';
}

/*
  The admin's chosen writing model (Admin → AI models → copy), the same one
  voice notes are tidied with — not the provider's quick model. The quick one
  answered "test" with "Test." and little else, which is how the button came
  to look broken on 1 October 2026.
*/
export async function rewriteNote(text: string, userId: string, style: RewriteStyle = 'polish'): Promise<RewriteAnswer> {
  if (!aiStatus().available) return { note: tidyNote(text), rewritten: false, reason: 'no_ai' };
  const answer = await complete({
    feature: 'note_rewrite',
    ...(await jobModel('copy')),
    system: 'You rewrite notes a property sales team leaves on a customer record. '
      + 'You keep the language the note was written in: English stays English, Hindi stays Hindi, '
      + 'Hinglish stays Hinglish in Latin script. You never translate. You never add a fact, a number, '
      + 'a name or a next step that is not in the note. You sound like a friendly, capable colleague, '
      + 'never corporate.',
    prompt: `Rewrite this note.\n\n"""${text.slice(0, 4_000)}"""\n\n`
      + `${STYLE_ASK[style]}\n`
      + '- Fix spelling, grammar and punctuation.\n'
      + '- Keep every number, name, date and amount exactly as written.\n'
      + '- No greeting, no heading, no sign-off, no quotes around it. Keep any emoji or @mention it already has.\n\n'
      + 'Return only the rewritten note.',
    maxTokens: 800,
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
