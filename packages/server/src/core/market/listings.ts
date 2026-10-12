/**
 * One message, many properties.
 *
 * A dealer's broadcast is rarely one deal. "Sachin Kumar Tyagi" posts twenty
 * plots in one message; a buyer's post asks for three things. Treated as one
 * deal it carried the first size and the first price and every sector it
 * mentioned, so it matched anybody, and the call sheet filled with pairings
 * that were wrong in the details a broker checks first.
 *
 * So a message is split into **listings** — one per property offered or
 * wanted — and everything downstream (the four tabs on an Associate, the
 * introductions) works on those. Two ways to split, the second better:
 *
 *  - `splitListings`: rules, no network, always available. Reads the
 *    message line by line, carries a sector heading down onto the lines under
 *    it, and starts a new listing at each new size.
 *  - `extractListingsWithAi`: the CRM's AI model reads the whole message and
 *    answers in JSON. Used for the long broadcasts where the rules are weakest,
 *    and it also throws out what is not a listing at all — a dispute notice, a
 *    festival greeting — which Jev only tags. If no model is connected the rules stand.
 */
import { completeJson, isAiAvailable } from '../../ai/client.js';
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { PROPERTY_CATEGORIES, withoutPhoneNumbers } from './jev.js';
import {
  bhkOf, categoryOf, kindOf, localitiesOf, looksLikeANotice, phonesOf, placeKeysOf, placesOf, priceOf, pricesIn,
  projectOf, readPost, sizeOf, tidyBody, totalFromRate, type PostReading,
} from './readPost.js';

export interface ListingDraft {
  kind: 'have' | 'want';
  purpose: 'sale' | 'rent';
  category: string | null;
  bhk: number | null;
  sizeSqYd: number | null;
  priceMinLakh: number | null;
  priceMaxLakh: number | null;
  /** Lower-cased, specific places only (see `placeKeysOf`). */
  placeKeys: string[];
  project: string | null;
  facing: string | null;
  floor: string | null;
  /** The part of the message this listing came from, for a person to read. */
  summary: string;
}

const MAX_LISTINGS = 60;
const SUMMARY_CHARS = 400;

const SEPARATOR = /^[\s━─—–\-=_*•·.~▪️🔹🔸#]{3,}$/u;
const RENT_WORDS = /\b(rent|rental|lease|leased|to[\s-]?let|kiraya|kiraye|किराया|किराए)\b/i;
const SALE_WORDS = /\b(for sale|on sale|sale|resale|sell|selling|demand|बिकाऊ|डिमांड)\b/i;

/** "To-let", "For Rent" with no sale word is a rental; "Sale"/"Demand" is a sale; anything else says nothing. */
function purposeWords(text: string): 'sale' | 'rent' | null {
  if (RENT_WORDS.test(text) && !SALE_WORDS.test(text)) return 'rent';
  if (SALE_WORDS.test(text)) return 'sale';
  return null;
}

/** A line that opens a new item in a list: an emoji bullet, "1." or "-". */
const BULLET = /^(?:[🏠🏡🏢🔹🔸👉👍⛳🔰•▶►]|\d{1,2}[.)]\s?(?=[A-Za-z])|[-–]\s)/u;

interface LineFacts {
  bullet: boolean;
  /** Sectors and localities only — a project name starts an item, it does not head a section. */
  area: string[];
  size: number | null;
  hasPrice: boolean;
  bhk: number | null;
  places: string[];
  contact: boolean;
}

function factsOf(line: string, known: string[]): LineFacts {
  const places = placeKeysOf({ places: placesOf(line, projectOf(line)), localities: localitiesOf(line, known), project: projectOf(line) });
  const priced = priceOf(line, purposeWords(line) ?? 'sale').min !== null;
  const size = sizeOf(line);
  const bhk = bhkOf(line);
  const wordsOnly = size === null && !priced && bhk === null;
  const area = placeKeysOf({ places: placesOf(line, projectOf(line)), localities: localitiesOf(line, known) });
  return {
    bullet: BULLET.test(line),
    area,
    size,
    hasPrice: priced,
    bhk,
    places,
    contact: wordsOnly && (phonesOf(line).length > 0 || /\b(contact|call|whatsapp|dm|sms|pls|please|mob|mobile|for more details|regards)\b/i.test(line)),
  };
}

/** A heading names a place and nothing else: "📍 SECTOR 15A", "Sector 76......". */
function isHeading(line: string, facts: LineFacts): boolean {
  return facts.area.length > 0 && facts.size === null && !facts.hasPrice && facts.bhk === null && line.length < 70;
}

function singleListing(body: string, whole: PostReading): ListingDraft | null {
  if (whole.kind === 'unknown') return null;
  return {
    kind: whole.kind,
    purpose: whole.purpose,
    category: whole.category,
    bhk: whole.bhk,
    sizeSqYd: whole.sizeSqYd,
    priceMinLakh: whole.priceMinLakh,
    priceMaxLakh: whole.priceMaxLakh,
    placeKeys: placeKeysOf(whole),
    project: whole.project,
    facing: null,
    floor: null,
    summary: body.slice(0, SUMMARY_CHARS),
  };
}

/**
 * How many separate properties a message looks like it carries, by counting the
 * lines that start one. Two or more is a list; the rules take it from here, and
 * three or more is long enough to be worth an AI model's read as well.
 */
export function listingLines(body: string, known: string[] = []): number {
  return tidyBody(body).split('\n').filter((line) => {
    const facts = factsOf(line, known);
    return facts.size !== null || (facts.hasPrice && facts.bhk !== null) || (facts.bullet && facts.hasPrice);
  }).length;
}

/** "250 / 350 / 500 Sq. Yds" with "₹3.65 Cr / ₹4.75 Cr / ₹5.45 Cr": three properties on one line. */
const SIZE_LIST = /(?<![\d.])(\d{2,4}(?:\.\d+)?(?:\s*[/,&]\s*\d{2,4}(?:\.\d+)?)+)\s*(?:sq|gaj|yard|yd|sy)/i;

function expandSizes(text: string, purpose: 'sale' | 'rent'): Array<{ size: number; min: number | null; max: number | null }> | null {
  const list = SIZE_LIST.exec(text);
  if (!list) return null;
  // Whole yards: "132.45" is 132 — and never "45", which is what its tail looks like on its own.
  const sizes = list[1]!.split(/[\s/,&]+/).map((part) => Math.round(Number(part))).filter((n) => n >= 20 && n <= 5000);
  if (sizes.length < 2) return null;
  const prices = pricesIn(text, purpose);
  // Sizes and prices of the same count pair up in order; otherwise the price is not known per size.
  return sizes.map((size, index) => (prices.length === sizes.length
    ? { size, min: prices[index]!.min, max: prices[index]!.max }
    : { size, min: null, max: null }));
}

export function splitListings(rawBody: string, known: string[] = [], whole: PostReading = readPost(rawBody, known)): ListingDraft[] {
  const body = tidyBody(rawBody);
  if (looksLikeANotice(body)) return [];
  if (listingLines(body, known) < 2) {
    const one = singleListing(body, whole);
    if (!one) return [];
    // One line can still be several properties: "Sizes: 132.45 & 137 Sq. Yds."
    const several = expandSizes(body, one.purpose);
    return several
      ? several.map((item) => ({ ...one, sizeSqYd: item.size, priceMinLakh: item.min, priceMaxLakh: item.max, placeKeys: [...one.placeKeys] }))
      : [one];
  }

  const drafts: ListingDraft[] = [];
  let heading: string[] = [];
  let sectionKind: ListingDraft['kind'] | null = whole.kind === 'unknown' ? null : whole.kind;
  let sectionPurpose: ListingDraft['purpose'] | null = null;
  // After "Call me" / "Contact", the names and firms that follow belong to nobody's listing.
  let inFooter = false;
  let current: string[] = [];
  let currentFacts: LineFacts[] = [];

  const flush = (): void => {
    const text = current.join('\n').trim();
    const hasPrice = currentFacts.some((f) => f.hasPrice);
    const sized = currentFacts.some((f) => f.size !== null) || hasPrice || currentFacts.some((f) => f.bhk !== null);
    const project = projectOf(text);
    const category = categoryOf(text);
    const worthKeeping = sized || (project !== null && category !== null);
    if (text && worthKeeping && drafts.length < MAX_LISTINGS) {
      const own = placeKeysOf({ places: placesOf(text, project), localities: localitiesOf(text, known), project });
      const kindHere = kindOf(text);
      const kind = kindHere !== 'unknown' ? kindHere : sectionKind;
      if (kind) {
        const purpose = purposeWords(text) ?? sectionPurpose ?? 'sale';
        const common = { kind, purpose, category, bhk: bhkOf(text), placeKeys: own.length ? own : heading, project, facing: null, floor: null, summary: text.slice(0, SUMMARY_CHARS) } as const;
        const several = expandSizes(text, purpose);
        if (several) {
          for (const item of several) drafts.push({ ...common, sizeSqYd: item.size, priceMinLakh: item.min, priceMaxLakh: item.max, placeKeys: [...common.placeKeys] });
        } else {
          const price = priceOf(text, purpose);
          const size = sizeOf(text);
          const total = price.min === null ? totalFromRate(price, size) : null;
          drafts.push({ ...common, sizeSqYd: size, priceMinLakh: price.min ?? total?.min ?? null, priceMaxLakh: price.max ?? total?.max ?? null, placeKeys: [...common.placeKeys] });
        }
      }
    }
    current = [];
    currentFacts = [];
  };

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (SEPARATOR.test(trimmed)) { flush(); continue; }
    const facts = factsOf(trimmed, known);
    const carriesAFact = facts.size !== null || facts.hasPrice || facts.bhk !== null;
    if (facts.contact) { flush(); inFooter = true; continue; }
    if (inFooter && !carriesAFact && facts.area.length === 0) continue;
    inFooter = false;

    if (isHeading(trimmed, facts)) {
      flush();
      heading = facts.area;
      // "Available for Sale – Sector 28" sets what the lines under it are, too.
      const kind = kindOf(trimmed);
      if (kind !== 'unknown') sectionKind = kind;
      sectionPurpose = purposeWords(trimmed) ?? sectionPurpose;
      continue;
    }
    if (!carriesAFact && trimmed.length < 90) {
      // "Available for Rent", "REQUIRED", "Plots For Sale": a section heading with no place.
      const kind = kindOf(trimmed);
      const purpose = purposeWords(trimmed);
      if (kind !== 'unknown' || purpose) {
        flush();
        if (kind !== 'unknown') sectionKind = kind;
        if (purpose) sectionPurpose = purpose;
        continue;
      }
    }
    const hasSizeAlready = currentFacts.some((f) => f.size !== null);
    const hasPriceAlready = currentFacts.some((f) => f.hasPrice);
    // A new size starts a new property; so does a new bullet once the last one has its price.
    const numbered = /^\d{1,2}[.)]/.test(trimmed);
    if (numbered || (facts.size !== null && (hasSizeAlready || hasPriceAlready)) || (facts.bullet && !facts.hasPrice && hasPriceAlready) || (facts.size !== null && facts.bullet && hasPriceAlready)) flush();
    current.push(trimmed);
    currentFacts.push(facts);
  }
  flush();

  return drafts.length ? drafts : (() => { const one = singleListing(body, whole); return one ? [one] : []; })();
}

// ---------------------------------------------------------------------------
// The AI read
// ---------------------------------------------------------------------------

const SYSTEM = `You read messages from WhatsApp groups of property brokers in Faridabad, Delhi-NCR, India.
One message can hold several separate properties on offer or several separate requirements. Split it into one listing each.

Rules:
- Ignore anything that is not a property listing or requirement: warnings, dispute or fraud notices, greetings, festival wishes, jokes, forwarded news, sign-ups. Answer is_property_post=false and no listings.
- kind "have": someone offers or sells or lets a property (available, for sale, demand, to-let, for rent).
  kind "want": someone needs one (required, requirement, looking for, need, urgent).
- purpose "rent" only for a rental or lease; otherwise "sale".
- size_sqyd: plot or built area in SQUARE YARDS (gaj). Convert nothing: if the size is in sq ft or sq metres, or absent, answer null.
- price_lakh_min / price_lakh_max: the TOTAL price in lakh rupees (1 crore = 100 lakh). For a rental the MONTHLY rent in lakh. A rate per square yard times the size is a total; if the size is unknown answer null. Never invent a price.
- sectors: sector numbers as "Sector 16" (with a letter if given, "Sector 21B"). One listing can name several. Put a project or society in project (BPTP, Adore, Omaxe World Street …), a colony or area in locality.
- category: one of ${PROPERTY_CATEGORIES.filter((c) => c !== 'Unknown').join(', ')}, or null.
- summary: the words of THIS listing only, shortened to under 140 characters.
- Never invent facts. Use null when a message does not say.`;

interface AiListing {
  kind?: string; purpose?: string; category?: string | null; bhk?: number | null; size_sqyd?: number | null;
  price_lakh_min?: number | null; price_lakh_max?: number | null; sectors?: string[]; project?: string | null;
  locality?: string | null; facing?: string | null; floor?: string | null; summary?: string;
}

const number = (value: unknown, min: number, max: number): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;

const whole = (value: number | null): number | null => (value === null ? null : Math.round(value));

/** The answer is the model's, so every field is checked before it is trusted. Pure for its test. */
export function draftsFromAi(answer: { is_property_post?: boolean; listings?: AiListing[] } | null, known: string[]): ListingDraft[] | null {
  if (!answer || !Array.isArray(answer.listings)) return null;
  if (answer.is_property_post === false) return [];
  const drafts: ListingDraft[] = [];
  for (const item of answer.listings.slice(0, MAX_LISTINGS)) {
    if (item.kind !== 'have' && item.kind !== 'want') continue;
    const sectors = (item.sectors ?? []).filter((s) => typeof s === 'string').map((s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim());
    const sectorKeys = sectors.flatMap((s) => placesOf(s.startsWith('sector') ? s : `sector ${s}`, null));
    const project = item.project ? projectOf(item.project) ?? item.project.toLowerCase().trim() : null;
    const locality = item.locality ? localitiesOf(item.locality, known) : [];
    const min = number(item.price_lakh_min, 0.01, 1_000_000);
    const max = number(item.price_lakh_max, 0.01, 1_000_000);
    drafts.push({
      kind: item.kind,
      purpose: item.purpose === 'rent' ? 'rent' : 'sale',
      category: item.category && PROPERTY_CATEGORIES.includes(item.category) && item.category !== 'Unknown' ? item.category : null,
      bhk: whole(number(item.bhk, 1, 14)),
      sizeSqYd: whole(number(item.size_sqyd, 20, 50_000)),
      priceMinLakh: min ?? max,
      priceMaxLakh: max ?? min,
      placeKeys: placeKeysOf({ places: sectorKeys, localities: locality, project }),
      project,
      facing: typeof item.facing === 'string' ? item.facing.slice(0, 40) : null,
      floor: typeof item.floor === 'string' ? item.floor.slice(0, 40) : null,
      summary: (item.summary ?? '').slice(0, 200),
    });
  }
  return drafts;
}

/** Null when no model is connected or the answer could not be used — the rules' split stands then. */
export async function extractListingsWithAi(rawBody: string, known: string[]): Promise<ListingDraft[] | null> {
  if (!isAiAvailable()) return null;
  try {
    const answer = await completeJson<{ is_property_post?: boolean; listings?: AiListing[] }>({
      feature: 'market_listings',
      fast: true,
      system: SYSTEM,
      prompt: `Message:\n"""\n${withoutPhoneNumbers(tidyBody(rawBody)).slice(0, 6000)}\n"""\n\nAnswer {"is_property_post": boolean, "listings": [...]}.`,
      maxTokens: 4000,
      temperature: 0,
    });
    const drafts = draftsFromAi(answer, known);
    // A model that returns listings with no summary is no help to a person reading the tab.
    return drafts?.map((draft, index) => ({ ...draft, summary: draft.summary || `Listing ${index + 1}` })) ?? null;
  } catch (err) {
    logger.warn({ err }, 'market: the AI read of a message failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Keeping them
// ---------------------------------------------------------------------------

/** Long enough, or list-like enough, that the rules' split deserves the AI model's second read. */
export function worthAnAiRead(body: string, known: string[] = []): boolean {
  return tidyBody(body).length > 350 || listingLines(body, known) >= 3;
}

/**
 * Replace a post's listings. `source` says who read it: the rules, or the AI model.
 * `complex` marks a rules' split that is waiting for the model — it is not written
 * into anyone's notes until the model has looked, so the note carries the right tabs.
 */
export async function saveListings(postId: string, drafts: ListingDraft[], source: 'rules' | 'ai', complex = false): Promise<void> {
  await db.query(`DELETE FROM ipy_market_listing WHERE post_id = $1`, [postId]);
  for (const [order, draft] of drafts.entries()) {
    await db.query(
      `INSERT INTO ipy_market_listing
         (post_id, ord, kind, purpose, category, bhk, size_sqyd, price_min_lakh, price_max_lakh,
          place_keys, project, facing, floor, summary, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [postId, order, draft.kind, draft.purpose, draft.category, whole(draft.bhk), whole(draft.sizeSqYd), draft.priceMinLakh,
        draft.priceMaxLakh, draft.placeKeys, draft.project, draft.facing, draft.floor, draft.summary, source],
    );
  }
  await db.query(
    `UPDATE ipy_market_post SET listings_source = $2, listings_checked_at = now(), ai_pending = $3 WHERE id = $1`,
    [postId, source, source === 'rules' && complex],
  );
}
