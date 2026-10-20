/**
 * Jev, TypeSafe's decision model, reading one dealer-group post.
 *
 * Jev does not read WhatsApp and does not pull free-form fields out of text.
 * It is handed a message and a few typed questions and answers each with a
 * probability, which is the right tool for "what IS this message?" — the one
 * judgement the word lists in `readPost.ts` get wrong most often.
 *
 * It rides on the OpenRouter key already in Admin → Integrations (the same
 * card the AI features use), so there is nothing new to set up. With no key,
 * or if Jev is down, every function here answers `null` and the word-list
 * reading stands (CLAUDE.md rule 7: AI degrades, it never blocks).
 */
import { getAiProviderSettings, getIntegrationCredentials } from '../settings/integrations.js';
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import type { PostReading } from './readPost.js';

/** Through OpenRouter, which is how Jev was first reached: one more hop and a pinned model version. */
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const OPENROUTER_MODEL = 'typesafe/jev-1.13';
/** Straight to TypeSafe (docs.typesafe.ai, read 20 October 2026): the same questions and answers, no middleman, the latest Jev. */
const DIRECT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DIRECT_MODEL = 'jev-latest';

export interface JevTarget { url: string; key: string; model: string; via: 'typesafe' | 'openrouter' }

/** A TypeSafe key (the Jev card, or TYPESAFE_API_KEY) wins; the OpenRouter key keeps working when there is none. */
export function jevTarget(): JevTarget | null {
  const direct = getIntegrationCredentials('typesafe_jev')?.apiKey?.trim() || process.env.TYPESAFE_API_KEY?.trim();
  if (direct) return { url: DIRECT_ENDPOINT, key: direct, model: DIRECT_MODEL, via: 'typesafe' };
  const routed = getAiProviderSettings('openrouter')?.apiKey;
  return routed ? { url: OPENROUTER_ENDPOINT, key: routed, model: OPENROUTER_MODEL, via: 'openrouter' } : null;
}

export const PROPERTY_CATEGORIES = [
  'Apartment', 'Builder Floor', 'Commercial Plot', 'Factory', 'Kothi/Villa',
  'Office Space', 'Residential Plot', 'Unknown',
];
const ROLES = ['Seller', 'Dealer', 'Builder', 'Buyer', 'Landlord', 'Tenant'];

/** `choice` criteria are a map of option → description; `score` criteria are an ordered list. */
const QUESTIONS = {
  kind: {
    type: 'choice',
    instructions: "Classify this message posted in an Indian real-estate dealers' WhatsApp group.",
    criteria: {
      inventory: 'Someone is offering or selling a property (for sale, बिकाऊ, demand/डिमांड, available, a listing with a price).',
      lead: 'Someone wants to buy or rent, or is asking for a property (requirement, चाहिए, looking for, client wants, buyer).',
      noise: 'Greetings, festival wishes, birthdays, forwards, poetry, person-added notices, or a media post with no property content.',
    },
  },
  is_property_post: {
    type: 'noul',
    instructions: 'The message concerns a specific property (plot, flat, builder floor, shop, office) with real-estate content.',
  },
  urgency: {
    type: 'score',
    instructions: 'How time-sensitive is this post for a dealer to follow up?',
    criteria: [
      'No time pressure at all',
      'Mild interest, ordinary listing',
      'Actively seeking, worth a prompt call',
      'Urgent or time-critical, call immediately',
    ],
  },
  category: {
    type: 'choice',
    instructions: 'Which property category best describes this post?',
    criteria: Object.fromEntries(PROPERTY_CATEGORIES.map((c) => [c, `A post about a ${c.toLowerCase()}.`])),
  },
  deal_type: {
    type: 'choice',
    instructions: 'Is this property deal about a sale or a rental?',
    criteria: {
      sale: 'Buying or selling a property outright (for sale, demand, requirement to purchase).',
      rent: 'Renting or leasing a property (to let, for rent, kiraya, tenant wanted or a tenant looking).',
    },
  },
  author_role: {
    type: 'choice',
    instructions: 'Who is posting this message?',
    criteria: {
      Seller: 'An owner disposing of their own property.',
      Dealer: 'A broker, agent or property consultancy.',
      Builder: 'A builder or developer.',
      Buyer: 'Someone seeking to acquire a property.',
      Landlord: 'Someone leasing out their property.',
      Tenant: 'Someone seeking to rent.',
    },
  },
};

export interface JevReading {
  kind: 'inventory' | 'lead' | 'noise' | null;
  kindConfidence: number | null;
  isPropertyPost: number | null;
  urgency: number | null;
  category: string | null;
  role: string | null;
  purpose: 'sale' | 'rent' | null;
  purposeConfidence: number | null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function chosen(answer: unknown): { pick: string | null; confidence: number | null } {
  const object = asObject(answer);
  if (!object) return { pick: typeof answer === 'string' ? answer : null, confidence: null };
  const pick = object.choice ?? object.selected;
  return {
    pick: typeof pick === 'string' ? pick : null,
    confidence: typeof object.confidence === 'number' ? object.confidence : null,
  };
}

/** A yes/no answer comes back as a bare number or wrapped under one of a few names. */
function number(answer: unknown, names: string[]): number | null {
  if (typeof answer === 'number') return answer;
  const object = asObject(answer);
  if (!object) return null;
  for (const name of names) {
    if (typeof object[name] === 'number') return object[name] as number;
  }
  return null;
}

/** Pure, so the shapes Jev answers in are pinned by a test and not by production. */
export function readJevAnswers(payload: unknown): JevReading | null {
  const top = asObject(payload);
  if (!top) return null;
  const answers = asObject(top.answers) ?? top;
  const kind = chosen(answers.kind);
  if (!kind.pick) return null;
  const role = chosen(answers.author_role).pick;
  const category = chosen(answers.category).pick;
  const deal = chosen(answers.deal_type);
  return {
    kind: kind.pick === 'inventory' || kind.pick === 'lead' || kind.pick === 'noise' ? kind.pick : null,
    kindConfidence: kind.confidence,
    isPropertyPost: number(answers.is_property_post, ['noul', 'probability', 'yes', 'value']),
    urgency: number(answers.urgency, ['score', 'value', 'position']),
    category: category && PROPERTY_CATEGORIES.includes(category) ? category : null,
    role: role && ROLES.includes(role) ? role : null,
    purpose: deal.pick === 'sale' || deal.pick === 'rent' ? deal.pick : null,
    purposeConfidence: deal.confidence,
  };
}

/** The classification does not need a number to be dialled, and it is not ours to hand to a third party. */
export function withoutPhoneNumbers(text: string): string {
  return text.replace(/(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g, '<phone>');
}

export function jevKey(): string | null {
  return jevTarget()?.key ?? null;
}

export function jevIsAvailable(): boolean {
  return jevTarget() !== null;
}

/** TypeSafe's published price (docs.typesafe.ai/models, 20 October 2026): $0.042 per million input tokens, output free. */
export const JEV_USD_PER_MILLION_TOKENS = 0.042;

let inFlight = 0;
let lastOkAt: Date | null = null;
let lastError: { at: Date; message: string } | null = null;

/** What Jev is doing right now, for the status line: how many questions are out, and when it last answered or failed. */
export function jevActivity(): { inFlight: number; lastOkAt: string | null; lastError: { at: string; message: string } | null; via: 'typesafe' | 'openrouter' | null; model: string | null } {
  const target = jevTarget();
  return { inFlight, lastOkAt: lastOkAt?.toISOString() ?? null, lastError: lastError ? { at: lastError.at.toISOString(), message: lastError.message } : null,
    via: target?.via ?? null, model: target?.model ?? null };
}

/** One row per day and kind, kept so the bill and the progress can be read. Never allowed to hold up a question. */
function noteUsage(kind: 'post' | 'pair', ok: boolean, tokens: number): void {
  void db.query(
    `INSERT INTO ipy_market_jev_usage (day, kind, calls, failed, input_tokens)
     VALUES ((now() AT TIME ZONE 'Asia/Kolkata')::date, $1, 1, $2, $3)
     ON CONFLICT (day, kind) DO UPDATE SET calls = ipy_market_jev_usage.calls + 1,
       failed = ipy_market_jev_usage.failed + $2, input_tokens = ipy_market_jev_usage.input_tokens + $3`,
    [kind, ok ? 0 : 1, Math.round(tokens)],
  ).catch((err) => logger.debug({ err }, 'market: Jev usage could not be counted'));
}

/** The one place Jev is called from, so every question is counted, timed out and reported the same way. */
async function callJev(kind: 'post' | 'pair', state: string, questions: object): Promise<{ payload: unknown } | { failed: 'no_key' | 'refused' | 'unreachable' }> {
  const target = jevTarget();
  if (!target) return { failed: 'no_key' };
  const estimate = state.length / 3.5;
  inFlight += 1;
  try {
    const res = await fetch(target.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${target.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: target.model, state, questions }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      lastError = { at: new Date(), message: `Jev answered ${res.status}` };
      noteUsage(kind, false, 0);
      logger.warn({ status: res.status, via: target.via }, 'market: Jev refused a question');
      return { failed: 'refused' };
    }
    const payload = await res.json() as { usage?: { input_tokens?: number } };
    lastOkAt = new Date();
    noteUsage(kind, true, typeof payload?.usage?.input_tokens === 'number' ? payload.usage.input_tokens : estimate);
    return { payload };
  } catch (err) {
    lastError = { at: new Date(), message: err instanceof Error ? err.message : 'Jev could not be reached' };
    noteUsage(kind, false, 0);
    logger.warn({ err }, 'market: Jev could not be reached');
    return { failed: 'unreachable' };
  } finally {
    inFlight -= 1;
  }
}

export type JevAnswer = { reading: JevReading } | { failed: 'no_key' | 'unreadable' | 'refused' | 'unreachable' };

/** Never throws: a Jev outage must not stop a group from being read. */
export async function askJev(text: string): Promise<JevAnswer> {
  const answer = await callJev('post', withoutPhoneNumbers(text).slice(0, 4000), QUESTIONS);
  if ('failed' in answer) return answer;
  const reading = readJevAnswers(answer.payload);
  return reading ? { reading } : { failed: 'unreadable' };
}

/** Below this, Jev is guessing and the word lists keep their say. */
const TRUST_KIND_AT = 0.7;
const TRUST_NOISE_AT = 0.8;

export interface MergedReading {
  kind: PostReading['kind'];
  purpose: PostReading['purpose'];
  isNoise: boolean;
  category: string | null;
  role: string | null;
  urgency: number | null;
}

/**
 * Jev's verdict over the word lists', but only when it is sure. A post Jev
 * calls noise with confidence is hidden rather than deleted, so a wrong call
 * is one query away from being undone.
 */
export function mergeReadings(words: PostReading, jev: JevReading): MergedReading {
  const sure = (jev.kindConfidence ?? 0) >= TRUST_KIND_AT;
  let kind = words.kind;
  if (sure && jev.kind === 'inventory') kind = 'have';
  if (sure && jev.kind === 'lead') kind = 'want';
  return {
    kind,
    purpose: jev.purpose && (jev.purposeConfidence ?? 0) >= TRUST_KIND_AT ? jev.purpose : words.purpose,
    isNoise: jev.kind === 'noise' && (jev.kindConfidence ?? 0) >= TRUST_NOISE_AT,
    category: jev.category && jev.category !== 'Unknown' ? jev.category : null,
    role: jev.role,
    urgency: jev.urgency,
  };
}

// ---------------------------------------------------------------------------
// A second opinion on a pairing
// ---------------------------------------------------------------------------

const FIT_QUESTIONS = {
  fit: {
    type: 'noul',
    instructions: 'The OFFER is a property that would genuinely satisfy the REQUIREMENT: the same kind of property, in the same area, with a size and price a buyer or tenant could accept.',
  },
};

/**
 * Pairings the team has already marked "not a real match", shown to Jev beside the one it is rating. This is
 * how a click on that button teaches Jev: it is told what this desk rejects, not only what the words say.
 */
export function examplesText(rejected: Array<{ requirement: string; offer: string }>): string {
  if (!rejected.length) return '';
  const lines = rejected.slice(0, 3).map((pair, index) => `${index + 1}. REQUIREMENT: ${pair.requirement.slice(0, 200)} | OFFER: ${pair.offer.slice(0, 200)}`);
  return `\n\nPAIRINGS THIS TEAM ALREADY REJECTED AS NOT A REAL MATCH (rate a similar pairing low):\n${lines.join('\n')}`;
}

/**
 * Jev's probability that an offer answers a requirement, or null when it could not say.
 *
 * Only the two listings' own lines are sent, never the whole messages: a broker's
 * twenty-plot broadcast beside a one-line requirement is not a question Jev can answer,
 * and the other nineteen plots are nobody's business.
 */
export async function askJevFit(requirement: string, offer: string, rejected: Array<{ requirement: string; offer: string }> = []): Promise<number | null> {
  const answer = await callJev('pair', withoutPhoneNumbers(`REQUIREMENT:\n${requirement.slice(0, 600)}\n\nOFFER:\n${offer.slice(0, 600)}${examplesText(rejected)}`), FIT_QUESTIONS);
  if ('failed' in answer) return null;
  const payload = asObject(answer.payload);
  const answers = asObject(payload?.answers) ?? payload;
  return number(answers?.fit, ['noul', 'probability', 'yes', 'value']);
}
