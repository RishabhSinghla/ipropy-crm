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
  /** For sale / buying, or to let / renting. Posts say "sale" far more often than they say it aloud, so that is the default. */
  purpose: 'sale' | 'rent';
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
  /** The name of a project or society the post names ("bptp", "adore"), or null. */
  project: string | null;
  phone: string | null;
  /** Every distinct mobile in the post, first one first (capped). */
  phones: string[];
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

/** WhatsApp's own tags and invisible marks inside a message, which are nothing a dealer wrote. */
const MESSAGE_TAGS = /<\s*this message was edited\s*>|<\s*media omitted\s*>|\b(?:image|video|audio|sticker|gif|document|contact card|poll)\s+omitted\b/gi;

/** What a person should read: the dealer's words without WhatsApp's tags, marks or runs of blank lines. */
export function tidyBody(body: string): string {
  return body
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(MESSAGE_TAGS, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Dealers type phone numbers as emoji keycaps (9️⃣9️⃣…) to dodge copy-paste; read them as digits. */
function withPlainDigits(text: string): string {
  return text.replace(/(\d)\uFE0F?\u20E3/g, '$1');
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

export function kindOf(body: string): PostReading['kind'] {
  if (SELLER_ASKING_FOR_A_BUYER.test(body)) return 'have';
  const want = WANT_WORDS.exec(body);
  const have = HAVE_WORDS.exec(body);
  if (want && have) return want.index <= have.index ? 'want' : 'have';
  if (want) return 'want';
  if (have) return 'have';
  return 'unknown';
}

export function bhkOf(body: string): number | null {
  const match = /\b(\d{1,2})\s*(?:\.5\s*)?bhk\b/i.exec(body);
  const bhk = match ? Number(match[1]) : NaN;
  return bhk > 0 && bhk < 15 ? bhk : null;
}

/** "1.5 cr", "150 lac", "80 L", "₹2.5 Cr", "2-2.5 cr", "1.4 to 1.6 crore", "1.25L to 1.35L". */
const PRICE = /(?:₹|rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:(?:(cr|crore|crores|lac|lacs|lakh|lakhs|l|k)\s*)?(?:-|to|–)\s*(\d+(?:\.\d+)?)\s*)?(cr|crore|crores|lac|lacs|lakh|lakhs|l|k)\b/gi;

/** "…@1.25 per sq yd", "55k per gaj", "11 acre … 7.5 cr per acre": a rate, not what the property costs. */
const RATE_AFTER = /^[\s.,]*(?:\/-?|per|p\.?|pr)\s*(?:sq|gaj|yard|yd|sy|acre|ft|feet)/i;

/** "25000 per month", "Rent 1.5 Lac Per Month", "30K pm". */
const MONTHLY_AFTER = /^\s*(?:\/-?\s*)?(?:per\s*month|p\.?m\.?\b|pm\b|\/\s*month|monthly)/i;

// Rounded, or 2.2 crore comes out as 220.00000000000003 lakh and shows up that way.
const toLakh = (value: number, unit: string): number => {
  const lakh = /^c/i.test(unit) ? value * 100 : /^k/i.test(unit) ? value / 100 : value;
  return Math.round(lakh * 10_000) / 10_000;
};

export interface PriceReading {
  min: number | null;
  max: number | null;
  /** A rate per square yard, in lakh, as a range: "1.25L to 1.35L per yard". */
  rateMin: number | null;
  rateMax: number | null;
}

/** Every price a piece of text names, in lakh (monthly rent for a rental), in the order written. */
export function pricesIn(text: string, purpose: 'sale' | 'rent' = 'sale'): Array<{ min: number; max: number }> {
  // "13,000" and "₹1,55,000" are one number.
  const body = text.replace(/(?<=\d),(?=\d{2,3}\b)/g, '');
  const found: Array<{ min: number; max: number }> = [];
  for (const match of body.matchAll(PRICE)) {
    const after = body.slice((match.index ?? 0) + match[0].length);
    const unit = match[4]!;
    const first = toLakh(Number(match[1]), match[2] ?? unit);
    const second = match[3] ? toLakh(Number(match[3]), unit) : first;
    if (RATE_AFTER.test(after)) continue;
    if (MONTHLY_AFTER.test(after) && purpose === 'sale') continue;
    if (purpose === 'sale' && first < 5) continue;
    found.push({ min: Math.min(first, second), max: Math.max(first, second) });
  }
  if (purpose === 'rent' && !found.length) {
    // A bare "25000 per month" has no unit word at all.
    for (const bare of body.matchAll(/(\d{4,6})\s*(?:\/-)?\s*(?:per\s*month|pm\b|p\.m|\/\s*month)/gi)) {
      found.push({ min: Number(bare[1]) / 100_000, max: Number(bare[1]) / 100_000 });
    }
  }
  return found;
}

/**
 * The price a post asks. Skips rates ("1.25 per sq yd", "7.5 cr per acre") — they
 * are not what the property costs, and reading "1.25" as 1.25 lakh priced a ₹4 Cr
 * plot at nothing. A rate per yard is returned on its own so a listing with a size
 * can work the total out.
 */
/**
 * "@1.35/Per Sq.yd.", "1.22/Sq.yd.", "1.25L to 1.35L per Sq yard", "55k per gaj", "₹1,55,000/Sqyd".
 * With no unit word, a small number is lakh a yard and a big one is rupees a yard.
 */
const RATE_PER_YARD = /(?:₹|rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:(cr|crore|lac|lacs|lakh|lakhs|l|k)\s*)?(?:(?:-|to|–)\s*(\d+(?:\.\d+)?)\s*(cr|crore|lac|lacs|lakh|lakhs|l|k)?\s*)?(?:\/-)?\s*(?:\/\s*(?:per\b\s*)?|\bper\b\s*|\bp\.?\s)(?:sq\.?\s*(?:yd|yds|yard|yards|yrd)|sqyd|gaj|yard|yd|sy\b)/i;

function rateInLakh(value: number, unit: string | undefined): number {
  if (unit) return toLakh(value, unit);
  return Math.round((value >= 1000 ? value / 100_000 : value) * 10_000) / 10_000;
}

/**
 * The price a post asks. Skips rates ("1.25 per sq yd", "7.5 cr per acre") — they
 * are not what the property costs, and reading "1.25" as 1.25 lakh priced a ₹4 Cr
 * plot at nothing. A rate per yard is returned on its own so a listing with a size
 * can work the total out.
 */
export function priceOf(text: string, purpose: 'sale' | 'rent' = 'sale'): PriceReading {
  const body = text.replace(/(?<=\d),(?=\d{2,3}\b)/g, '');
  const rate = RATE_PER_YARD.exec(body);
  let rateMin: number | null = null;
  let rateMax: number | null = null;
  if (rate) {
    const first = rateInLakh(Number(rate[1]), rate[2]);
    // "1.25L to 1.35L": the second number may carry the unit for both.
    const second = rate[3] ? rateInLakh(Number(rate[3]), rate[4] ?? rate[2]) : first;
    rateMin = Math.min(first, second);
    rateMax = Math.max(first, second);
  }
  const best = pricesIn(body, purpose)[0];
  return { min: best?.min ?? null, max: best?.max ?? null, rateMin, rateMax };
}

/** What a rate per yard comes to on a stated size: { min, max } in lakh, or null when either is missing. */
export function totalFromRate(price: PriceReading, size: number | null): { min: number; max: number } | null {
  if (price.rateMin === null || price.rateMax === null || size === null) return null;
  return { min: price.rateMin * size, max: price.rateMax * size };
}

/**
 * Every Indian mobile in a post, first to last. The first is the number to ring.
 * `(?<!\d)` and the optional country code: without the first the tail of a longer
 * number glues onto the digits after it ("…76543 25000" read as 7654325000).
 */
export function phonesOf(body: string): string[] {
  const found: string[] = [];
  for (const match of withPlainDigits(body).matchAll(/(?<!\d)(?:\+?91[\s-]?|0)?([6-9]\d{4}[\s-]?\d{5})(?!\d)/g)) {
    const number = match[1]!.replace(/\D/g, '');
    if (!found.includes(number)) found.push(number);
  }
  return found.slice(0, 6);
}

/**
 * Which of the business's own localities a post names. The list comes from
 * the CRM, never from this file, so a new colony an admin adds is read the
 * day it is added.
 */
export function localitiesOf(body: string, known: string[]): string[] {
  const lower = body.toLowerCase();
  return known.filter((name) => {
    const word = name.trim().toLowerCase();
    // "Greenfields Colony" should match a post saying "greenfield".
    const stem = word.replace(/\s+(colony|sector|city|enclave|extension|nagar)$/i, '').replace(/s$/, '');
    return word.length > 2 && (namesWord(lower, word) || (stem.length > 3 && namesWord(lower, stem)));
  });
}

/**
 * Whole words only. A name found inside another word sent the NIT area of Faridabad onto every
 * post that said "single unit", "Nitesh" or "community": 1,183 listings carried it as their only
 * place, and Greenfield flats were paired with NIT ones. A plural ("greenfields") still counts.
 */
function namesWord(lowerBody: string, lowerName: string): boolean {
  const escaped = lowerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}s?(?![\\p{L}\\p{N}])`, 'u').test(lowerBody);
}

/** Names that say nothing about where: everything here is in Faridabad. Matching on them paired strangers. */
const GENERIC_AREAS = new Set(['faridabad', 'delhi', 'new delhi', 'gurgaon', 'gurugram', 'noida', 'gaziabad', 'ghaziabad', 'ncr', 'industrial', 'haryana']);

/** Large areas a post may name; a match on one is real but weaker than the same sector. */
export const BROAD_AREAS = new Set(['greater faridabad', 'nit', 'mathura road', 'palwal', 'ballabgarh', 'prithla', 'neharpar']);

/** Developers and societies; "bptp" is a real signal and a wide one, so it is a broad key. */
const PROJECT = /\b(bptp|amolik|omaxe|adore|mansha|rps|puri|srs|eros|dlf|ansal|soha|anjani putra|anushree|kohinoor|emerald|florida|auric|parkland|district\s*\d|discovery|tdi|slf|nirvana|bhumika|navraj|vamana|artech|raas|tarang|vipul|hewo|mahindra|godrej|elite|princess park|aravali heights|manglam|tulip|omaxe world street|world street)\b/i;

/** A place key that is a developer or society rather than a sector or a colony. */
export function isProjectKey(key: string): boolean {
  return !key.includes(':') && PROJECT.test(key) && key.length <= 24;
}

export function projectOf(body: string): string | null {
  const match = PROJECT.exec(body);
  return match ? match[1]!.toLowerCase().replace(/\s+/g, ' ') : null;
}

/**
 * "Sector 75-76-77", "sec 21 B,C,D", "Sector 28 or 29", "Sector-21A": each one a key.
 * A bare letter after a number is a pocket of that sector ("21 B, C, D" → 21b 21c 21d).
 */
function sectorsOf(body: string): string[] {
  const found = new Set<string>();
  const ITEM = String.raw`\d{1,3}\s?[a-z]?(?![a-z0-9])`;
  // Further sectors join only through a comma, slash, dash, "and" or "or" — never a bare space, or
  // "sector 21 3 BHK" and "sector 21 1.1 cr" would name sectors 3 and 1.
  const SEPARATOR = String.raw`\s*(?:,|/|&|-|\band\b|\bor\b|\bto\b)\s*`;
  const run = new RegExp(String.raw`\bsec(?:tor)?s?\.?[-\s]*(${ITEM}(?:${SEPARATOR}(?:${ITEM}|[a-z](?![a-z0-9])))*)`, 'gi');
  for (const match of body.matchAll(run)) {
    let lastNumber = '';
    // "21 B" is the B pocket of sector 21; "21, B" is the same after a comma. Join the first kind.
    const joined = match[1]!.replace(/(\d)[\s-]([a-z])(?![a-z0-9])/gi, '$1$2');
    for (const token of joined.split(/\s*(?:,|\/|&|-|\band\b|\bor\b|\bto\b)\s*/i).map((t) => t.trim()).filter(Boolean)) {
      const sector = /^(\d{1,3})([a-z])?$/i.exec(token);
      if (sector && Number(sector[1]) <= 150) {
        lastNumber = sector[1]!;
        found.add(`sector ${sector[1]}${(sector[2] ?? '').toLowerCase()}`);
      } else if (/^[a-z]$/i.test(token) && lastNumber) {
        found.add(`sector ${lastNumber}${token.toLowerCase()}`);
      }
    }
  }
  return [...found];
}

/** A block means little alone ("D block" exists in every project); it counts only beside the project it belongs to. */
function blocksOf(body: string, project: string | null): string[] {
  if (!project) return [];
  const letters = new Set<string>();
  for (const match of body.matchAll(/\b([a-z])\s*block\b|\bblock[-\s]?([a-z])\b/gi)) letters.add((match[1] ?? match[2]!).toUpperCase());
  return [...letters].map((letter) => `${project}:block ${letter}`);
}

export function placesOf(body: string, project: string | null): string[] {
  return [...sectorsOf(body), ...blocksOf(body, project)];
}

const YARD_UNIT = String.raw`(?:sq\.?\s*(?:yd|yds|yrd|yrds|yard|yards|yr)\.?|sqyd|sqyds|sqyrd|sqr\s*yard|syd|sy\b|gaj|yards?\b|गज|यार्ड)`;
const SIZE_ONE = new RegExp(String.raw`(\d{2,5}(?:\.\d+)?)\s*${YARD_UNIT}`, 'i');
// A bare "80-90" is far more often a price than a size, so a range needs the unit after it.
const SIZE_RANGE = new RegExp(String.raw`(\d{2,5})\s*(?:-|–|to)\s*(\d{2,5})\s*${YARD_UNIT}`, 'i');

export function sizeOf(body: string): number | null {
  const range = SIZE_RANGE.exec(body);
  // Whole yards: "132.45 Sq. Yds." is 132, and size is a whole-number column.
  const size = Math.round(range ? (Number(range[1]) + Number(range[2])) / 2 : Number(SIZE_ONE.exec(body)?.[1]));
  return size >= 20 && size <= 5000 ? size : null;
}

/** First match wins, narrowest first: "3 BHK builder floor" is a builder floor, not an apartment. */
const CATEGORY_WORDS: Array<[string, RegExp]> = [
  ['Kothi/Villa', /\b(kothi|villa|bungalow)\b/i],
  ['Builder Floor', /\bbuilder'?s?\s*floors?\b|\bbf\b/i],
  ['Office Space', /\b(office|it\s*space)\b/i],
  ['Factory', /\b(factory|shed|godown|warehouse)\b/i],
  ['Commercial Plot', /\b(shop|showroom|retail|commercial)\b/i],
  ['Apartment', /\b(flat|apartment|\d\s?bhk)\b/i],
  ['Residential Plot', new RegExp(String.raw`\bplot\b|${YARD_UNIT}`, 'i')],
];

export function categoryOf(body: string): string | null {
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
export function placeKeysOf(reading: Pick<PostReading, 'places' | 'localities'> & { project?: string | null }): string[] {
  const keys = [...reading.places, ...reading.localities, ...(reading.project ? [reading.project] : [])].map((place) => place.toLowerCase());
  // A bare city says nothing: every post here is in Faridabad.
  return [...new Set(keys.filter((key) => !GENERIC_AREAS.has(key)))];
}

const RENT_WORDS = /\b(rent|rental|rented out|lease|leased|to[\s-]?let|kiraya|kiraye|किराया|किराए|किरायेदार|tenant)\b/i;
const SALE_WORDS = /\b(for sale|on sale|sale|resale|sell|selling|demand|बिकाऊ|डिमांड|बेचनी)\b/i;

/** A post that says rent and never says sale is a rental; a sale ad quoting a tenant's rent still says sale. */
export function purposeOf(body: string): PostReading['purpose'] {
  return RENT_WORDS.test(body) && !SALE_WORDS.test(body) ? 'rent' : 'sale';
}

export function readPost(rawBody: string, knownLocalities: string[] = []): PostReading {
  const body = withPlainDigits(tidyBody(rawBody));
  const purpose = purposeOf(body);
  const price = priceOf(body, purpose);
  const size = sizeOf(body);
  const project = projectOf(body);
  // A rate per yard and a size make a total; "1.25 per sq yd" on 250 yd is ₹3.1 Cr.
  const total = price.min === null ? totalFromRate(price, size) : null;
  const phones = phonesOf(body);
  return {
    kind: kindOf(body),
    purpose,
    bhk: bhkOf(body),
    priceMinLakh: price.min ?? total?.min ?? null,
    priceMaxLakh: price.max ?? total?.max ?? null,
    localities: localitiesOf(body, knownLocalities),
    places: placesOf(body, project),
    sizeSqYd: size,
    category: categoryOf(body),
    project,
    phone: phones[0] ?? null,
    phones,
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

/**
 * A warning, a dispute or a fraud notice: addressed to dealers, naming a property,
 * and asking for nothing. It has a size and a plot number, so the word lists read it
 * as somebody wanting to buy; nobody does.
 */
export function looksLikeANotice(body: string): boolean {
  const text = tidyBody(body);
  return /\b(dispute|disputed|fraud|fraudulent|cheated|cheating|beware|caution(?:ed)?|legal consequences|legal action|stolen|forged|fake documents?)\b/i.test(text)
    && pricesIn(text).length === 0;
}
