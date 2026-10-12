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
import { getAiProviderSettings } from '../settings/integrations.js';
import { logger } from '../../utils/logger.js';
import type { PostReading } from './readPost.js';

const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const MODEL = 'typesafe/jev-1.13';

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
  return getAiProviderSettings('openrouter')?.apiKey || null;
}

export function jevIsAvailable(): boolean {
  return jevKey() !== null;
}

export type JevAnswer = { reading: JevReading } | { failed: 'no_key' | 'unreadable' | 'refused' | 'unreachable' };

/** Never throws: a Jev outage must not stop a group from being read. */
export async function askJev(text: string): Promise<JevAnswer> {
  const key = jevKey();
  if (!key) return { failed: 'no_key' };
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, state: withoutPhoneNumbers(text).slice(0, 4000), questions: QUESTIONS }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'market: Jev refused a post');
      return { failed: 'refused' };
    }
    const reading = readJevAnswers(await res.json());
    return reading ? { reading } : { failed: 'unreadable' };
  } catch (err) {
    logger.warn({ err }, 'market: Jev could not be reached');
    return { failed: 'unreachable' };
  }
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
