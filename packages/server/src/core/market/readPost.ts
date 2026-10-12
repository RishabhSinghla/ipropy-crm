/**
 * Turning a WhatsApp group export into deals.
 *
 * Pure on purpose: no database, no AI, so every rule here is pinned by a unit
 * test and works with no AI provider at all (CLAUDE.md rule 7). A model can
 * improve on these readings later; it must never be the only way to get one.
 */
import { createHash } from 'node:crypto';

export interface ChatMessage {
  postedAt: Date | null;
  sender: string;
  body: string;
}

export interface PostReading {
  kind: 'have' | 'want' | 'unknown';
  bhk: number | null;
  priceMinLakh: number | null;
  priceMaxLakh: number | null;
  localities: string[];
  /** "sector 85", "block d" — a plot is matched on these, which no dropdown can list. */
  places: string[];
  /** Plot size in square yards (gaj), the unit this market quotes plots in. */
  sizeSqYd: number | null;
  /** One of the property categories Jev also answers in, or null when the words do not say. */
  category: string | null;
  phone: string | null;
}

/*
  The two shapes WhatsApp writes an export in:
    Android  12/10/2025, 10:15 am - Ramesh Dealer: 3 BHK available …
    iPhone   [12/10/25, 10:15:30 AM] Ramesh Dealer: 3 BHK available …
  Indian phones write the day first. A line that matches neither carries on
  the message above it — a long post spans many lines.
*/
const ANDROID_LINE = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?\s+-\s+([^:]{1,80}):\s?(.*)$/i;
const IPHONE_LINE = /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?\]\s+([^:]{1,80}):\s?(.*)$/i;

/** WhatsApp's own placeholders, not anything a dealer said. */
const NOT_A_POST = /^(<media omitted>|image omitted|video omitted|this message was deleted|you deleted this message|null|<attached: .*>)$/i;

function toDate(day: string, month: string, year: string, hour: string, minute: string, ampm?: string): Date | null {
  let y = Number(year);
  if (y < 100) y += 2000;
  let h = Number(hour);
  const meridiem = ampm?.toLowerCase().replace(/\./g, '');
  if (meridiem === 'pm' && h < 12) h += 12;
  if (meridiem === 'am' && h === 12) h = 0;
  // Read as India time: an export carries no zone, and these groups are Indian.
  const date = new Date(Date.UTC(y, Number(month) - 1, Number(day), h - 5, Number(minute) - 30));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseWhatsAppExport(text: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  // Exports put an invisible narrow space before am/pm and a mark at the start of some lines.
  const lines = text.replace(/[  ]/g, ' ').replace(/‎/g, '').split(/\r?\n/);

  for (const line of lines) {
    const match = ANDROID_LINE.exec(line) ?? IPHONE_LINE.exec(line);
    if (match) {
      const [, day, month, year, hour, minute, ampm, sender, body] = match;
      messages.push({ postedAt: toDate(day!, month!, year!, hour!, minute!, ampm), sender: sender!.trim(), body: body ?? '' });
    } else if (messages.length && line.trim()) {
      messages[messages.length - 1]!.body += `\n${line}`;
    }
  }

  return messages
    .map((message) => ({ ...message, body: message.body.trim() }))
    .filter((message) => message.body && !NOT_A_POST.test(message.body));
}

/*
  Words that say which side of a deal a post is on. A post can carry both
  ("available for a buyer who needs…"), so the earliest one wins: dealers
  lead with what they are offering or asking for.
*/
const WANT_WORDS = /\b(required|requirement|req|need|needed|wanted|want|looking for|buyer for|client for|client looking|in search of)\b/i;
const HAVE_WORDS = /\b(available|avl|avail|for sale|on sale|sale|resale|ready to move|possession|owner property|inventory|fresh|direct deal|sell)\b/i;

/** "Need buyer" and "buyer required" are a seller talking, though they say need. */
const SELLER_ASKING_FOR_A_BUYER = /\b(?:need|needed|required|want|looking for)\s+(?:a\s+)?(?:buyer|purchaser|client)s?\b|\b(?:buyer|purchaser)s?\s+(?:required|needed|wanted)\b/i;

function kindOf(body: string): PostReading['kind'] {
  if (SELLER_ASKING_FOR_A_BUYER.test(body)) return 'have';
  const want = WANT_WORDS.exec(body);
  const have = HAVE_WORDS.exec(body);
  if (want && have) return want.index <= have.index ? 'want' : 'have';
  if (want) return 'want';
  if (have) return 'have';
  return 'unknown';
}

function bhkOf(body: string): number | null {
  const match = /\b(\d{1,2})\s*(?:\.5\s*)?bhk\b/i.exec(body);
  const bhk = match ? Number(match[1]) : NaN;
  return bhk > 0 && bhk < 15 ? bhk : null;
}

/** "1.5 cr", "1.5cr", "150 lac", "80 L", "₹2.5 Cr", "2-2.5 cr", "1.4 to 1.6 crore". */
const PRICE = /(?:₹|rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:(?:-|to|–)\s*(\d+(?:\.\d+)?)\s*)?(cr|crore|crores|lac|lacs|lakh|lakhs|l)\b/i;

function priceOf(body: string): { min: number | null; max: number | null } {
  const match = PRICE.exec(body);
  if (!match) return { min: null, max: null };
  const toLakh = (value: number): number => (/^c/i.test(match[3]!) ? value * 100 : value);
  const first = toLakh(Number(match[1]));
  const second = match[2] ? toLakh(Number(match[2])) : first;
  // A size like "250 L" yard posts is rare; a figure under 5 lakh is not a home price.
  if (first < 5) return { min: null, max: null };
  return { min: Math.min(first, second), max: Math.max(first, second) };
}

/** Indian mobiles only; the last ten digits are what every other match in this CRM uses. */
function phoneOf(body: string): string | null {
  const match = /(?:\+?91[\s-]?)?([6-9]\d{4}[\s-]?\d{5})\b/.exec(body);
  return match ? match[1]!.replace(/\D/g, '') : null;
}

/**
 * Which of the business's own localities a post names. The list comes from
 * the CRM, never from this file, so a new colony an admin adds is read the
 * day it is added.
 */
function localitiesOf(body: string, known: string[]): string[] {
  const lower = body.toLowerCase();
  return known.filter((name) => {
    const word = name.trim().toLowerCase();
    // "Greenfields Colony" should match a post saying "greenfield".
    const stem = word.replace(/\s+(colony|sector|city|enclave|extension|nagar)$/i, '').replace(/s$/, '');
    return word.length > 2 && (lower.includes(word) || (stem.length > 3 && lower.includes(stem)));
  });
}

const SECTOR = /\b(?:sec(?:tor)?\.?[-\s]?)(\d{1,3})\s*([a-z])?\b/gi;
const BLOCK = /\bblock[-\s]?([a-z])\b/gi;
const YARD_UNIT = String.raw`(?:sq\.?\s*(?:yd|yard|yards)|sqyd|gaj|गज|यार्ड)`;
const SIZE_ONE = new RegExp(String.raw`(\d{2,5})\s*${YARD_UNIT}`, 'i');
// A bare "80-90" is far more often a price than a size, so a range needs the unit after it.
const SIZE_RANGE = new RegExp(String.raw`(\d{2,5})\s*(?:-|–|to)\s*(\d{2,5})\s*${YARD_UNIT}`, 'i');

function placesOf(body: string): string[] {
  const found = new Set<string>();
  for (const m of body.matchAll(SECTOR)) found.add(`sector ${m[1]}${(m[2] ?? '').toLowerCase()}`);
  for (const m of body.matchAll(BLOCK)) found.add(`block ${m[1]!.toUpperCase()}`);
  return [...found];
}

function sizeOf(body: string): number | null {
  const range = SIZE_RANGE.exec(body);
  const size = range ? Math.round((Number(range[1]) + Number(range[2])) / 2) : Number(SIZE_ONE.exec(body)?.[1]);
  return size >= 20 && size <= 5000 ? size : null;
}

/** First match wins, narrowest first: "3 BHK builder floor" is a builder floor, not an apartment. */
const CATEGORY_WORDS: Array<[string, RegExp]> = [
  ['Kothi/Villa', /\b(kothi|villa|bungalow)\b/i],
  ['Builder Floor', /\b(builder\s*floor|bf|stilt)\b/i],
  ['Office Space', /\b(office|it\s*space)\b/i],
  ['Factory', /\b(factory|shed|godown|warehouse)\b/i],
  ['Commercial Plot', /\b(shop|showroom|retail|commercial)\b/i],
  ['Apartment', /\b(flat|apartment|\d\s?bhk)\b/i],
  ['Residential Plot', new RegExp(String.raw`\bplot\b|${YARD_UNIT}`, 'i')],
];

function categoryOf(body: string): string | null {
  return CATEGORY_WORDS.find(([, words]) => words.test(body))?.[0] ?? null;
}

/** What a post is about in the broad sense a buyer and seller must agree on. */
export function categoryFamily(category: string | null): 'plot' | 'home' | 'commercial' | null {
  if (category === 'Residential Plot') return 'plot';
  if (category === 'Apartment' || category === 'Builder Floor' || category === 'Kothi/Villa') return 'home';
  if (category === 'Commercial Plot' || category === 'Office Space' || category === 'Factory') return 'commercial';
  return null;
}

/** Sectors, blocks and the business's own localities, lower-cased: the keys two posts are matched on. */
export function placeKeysOf(reading: Pick<PostReading, 'places' | 'localities'>): string[] {
  return [...new Set([...reading.places, ...reading.localities].map((place) => place.toLowerCase()))];
}

export function readPost(body: string, knownLocalities: string[] = []): PostReading {
  const price = priceOf(body);
  return {
    kind: kindOf(body),
    bhk: bhkOf(body),
    priceMinLakh: price.min,
    priceMaxLakh: price.max,
    localities: localitiesOf(body, knownLocalities),
    places: placesOf(body),
    sizeSqYd: sizeOf(body),
    category: categoryOf(body),
    phone: phoneOf(body),
  };
}

/**
 * The same deal forwarded into ten groups is one deal. Case, spacing and
 * punctuation differ between forwards; the words and the numbers do not.
 */
export function fingerprintOf(body: string): string {
  const normal = body.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return createHash('sha256').update(normal).digest('hex');
}

/** A chat line too short to be a deal: "ok", "👍", "call me". */
export function looksLikeADeal(body: string, reading: PostReading): boolean {
  if (body.length < 15) return false;
  return reading.bhk !== null || reading.sizeSqYd !== null || reading.priceMinLakh !== null || reading.kind !== 'unknown' || reading.localities.length > 0;
}
