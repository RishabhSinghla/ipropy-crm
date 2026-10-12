/**
 * What one dealer has posted in the groups, as four lists on their record.
 *
 * An Associate is a dealer; the properties they post are the reason they are worth
 * having in the CRM. Sorted the way a rep thinks about them: what they have to sell,
 * what they have to let, what their buyers want, what their tenants want.
 *
 * Each row is one **listing** (one property), not one message — a broker who posts
 * twenty plots in a message has twenty rows, each with its own sector, size and
 * price, and each opens the whole message when clicked. They are the same rows the
 * introductions are made from, so nothing here is a second copy to keep in step.
 *
 * Found by the dealer's number (the last ten digits, as every other match in this
 * CRM). A record whose number nobody has posted under simply has four empty lists.
 */
import { db } from '../../db/pool.js';
import { registry } from '../metadata/registry.js';
import { getRecord, type ServiceContext } from '../entity/recordService.js';
import { mobileIdentities } from '../entity/mobileIdentity.js';
import { label } from './crossMatch.js';
import { quadrantOf } from './dealerNotes.js';
import { tidyBody } from './readPost.js';

export interface DealerDeal {
  /** The listing — one property — or, once the team has touched it, their own row standing in for it. */
  id: string;
  /** Stays the same when the team first edits the row (the listing becomes their row), so a screen can keep it selected. */
  key: string;
  /** What the edit, duplicate and delete routes take: `post:<postId>:<ord>` until adopted, then the row's own id. */
  ref: string;
  /** True once the team has a row of their own for this deal (so an edit is not the parser's reading any more). */
  stored: boolean;
  postId: string;
  /** The words of this listing; `body` is the whole message it came from. */
  summary: string;
  body: string;
  category: string | null;
  project: string | null;
  facing: string | null;
  floor: string | null;
  bhk: number | null;
  sizeSqYd: number | null;
  priceMinLakh: number | null;
  priceMaxLakh: number | null;
  places: string[];
  groups: string[];
  seenCount: number;
  postedAt: string | null;
  urgency: number | null;
  purpose: 'sale' | 'rent';
  /** What the team has filled in. All empty until somebody opens the row's form. */
  houseNo: string | null;
  portion: string | null;
  nextFollowUpAt: string | null;
  propertyStatus: string | null;
  lostReason: string | null;
  source: string | null;
  /** Keys an admin added to the form in Admin -> Layouts. */
  extra: Record<string, string>;
}

export interface DealerDeals {
  /** They have it and want to sell it. */
  forSale: DealerDeal[];
  /** Their buyer wants to purchase. */
  buyerRequirements: DealerDeal[];
  /** They have it and want to let it. */
  forRent: DealerDeal[];
  /** Their tenant wants to rent. */
  tenantRequirements: DealerDeal[];
  /** True when a list was cut at the newest {@link LIMIT}, so a count reads "100+" and not "100". */
  truncated: boolean;
}

const LIMIT = 100;
// Keep the Associate's personal deal lists aligned with the Market screen's
// freshness window: stale posts should not crowd out today's useful stock.
const DAYS = 45;

/** The business's own spelling first ("Sector 78"); the reader's lower-cased twin of it is dropped. */
export function onceEach(names: string[]): string[] {
  const seen = new Set<string>();
  return names.filter((name) => !seen.has(name.toLowerCase()) && !!seen.add(name.toLowerCase()));
}

export function bucketDeals(rows: Array<{ kind: string; purpose: string | null; deal: DealerDeal }>): DealerDeals {
  const result: DealerDeals = { forSale: [], buyerRequirements: [], forRent: [], tenantRequirements: [], truncated: false };
  for (const { kind, purpose, deal } of rows) {
    const list = result[quadrantOf(kind, purpose ?? 'sale')];
    if (list.length < LIMIT) list.push(deal);
    else result.truncated = true;
  }
  return result;
}

type Row = Record<string, unknown>;
type Bucketable = { kind: string; purpose: string | null; deal: DealerDeal };

const DERIVED_SQL = `SELECT l.id, l.post_id, l.ord, l.kind, l.purpose, l.summary, l.category, l.project, l.facing, l.floor, l.bhk, l.size_sqyd, l.price_min_lakh, l.price_max_lakh,
            l.place_keys, p.body, p.groups, p.seen_count, p.urgency, coalesce(p.last_posted_at, p.created_at) AS posted_at
       FROM ipy_market_listing l JOIN ipy_market_post p ON p.id = l.post_id`;

/** The listings the parser read from this dealer's posts. `extraWhere` narrows them, and may use $3 onwards. */
export async function derivedListings(numbers: string[], extraWhere = '', extraParams: unknown[] = []): Promise<Row[]> {
  const rows = await db.query<Row>(
    `${DERIVED_SQL}
      WHERE p.poster_phone = ANY($1::text[]) AND NOT p.is_noise
        AND coalesce(p.last_posted_at, p.created_at) > now() - make_interval(days => $2::int) ${extraWhere}
      ORDER BY coalesce(p.last_posted_at, p.created_at) DESC, l.ord
      LIMIT 1000`,
    [numbers, DAYS, ...extraParams],
  );
  return rows.rows;
}

/** The team's own rows for one dealer, dates as plain `YYYY-MM-DD` so a timezone cannot move a follow-up a day. */
export async function storedDeals(recordId: string): Promise<Row[]> {
  const rows = await db.query<Row>(
    `SELECT id, post_id, source_ord, kind, purpose, is_deleted, summary, body, groups, seen_count, posted_at,
            house_no, locality, category, project, facing, floor, portion, bhk, size_sqyd, price_min_lakh, price_max_lakh,
            to_char(next_followup_at, 'YYYY-MM-DD') AS next_followup_at, property_status, lost_reason, source, extra
       FROM ipy_associate_deal WHERE record_id = $1`,
    [recordId],
  );
  return rows.rows;
}

const NO_DETAILS = { houseNo: null, portion: null, nextFollowUpAt: null, propertyStatus: null, lostReason: null, source: null, extra: {} };

function fromListing(row: Row): Bucketable {
  return {
    kind: row.kind as string,
    purpose: row.purpose as string | null,
    deal: {
      id: row.id as string,
      key: `${row.post_id as string}:${row.ord as number}`,
      ref: `post:${row.post_id as string}:${row.ord as number}`,
      stored: false,
      postId: row.post_id as string,
      summary: row.summary as string,
      body: tidyBody(row.body as string),
      category: row.category as string | null,
      project: row.project as string | null,
      facing: row.facing as string | null,
      floor: row.floor as string | null,
      bhk: row.bhk as number | null,
      sizeSqYd: row.size_sqyd as number | null,
      priceMinLakh: row.price_min_lakh as number | null,
      priceMaxLakh: row.price_max_lakh as number | null,
      places: onceEach((row.place_keys as string[]).map(label)),
      groups: row.groups as string[],
      seenCount: row.seen_count as number,
      postedAt: row.posted_at ? new Date(row.posted_at as string).toISOString() : null,
      urgency: row.urgency as number | null,
      purpose: row.purpose as 'sale' | 'rent',
      ...NO_DETAILS,
    },
  };
}

function fromStored(row: Row): Bucketable {
  const locality = (row.locality as string | null)?.trim();
  return {
    kind: row.kind as string,
    purpose: row.purpose as string,
    deal: {
      id: row.id as string,
      // A row that replaced a listing keeps that listing's key; a duplicate replaced nothing and has only its own.
      key: row.source_ord === null ? (row.id as string) : `${row.post_id as string}:${row.source_ord as number}`,
      ref: row.id as string,
      stored: true,
      postId: row.post_id as string,
      summary: row.summary as string,
      body: tidyBody(row.body as string),
      category: row.category as string | null,
      project: row.project as string | null,
      facing: row.facing as string | null,
      floor: row.floor as string | null,
      bhk: row.bhk as number | null,
      // NUMERIC arrives as a JS number through the pool's type parser (db/pool.ts).
      sizeSqYd: row.size_sqyd as number | null,
      priceMinLakh: row.price_min_lakh as number | null,
      priceMaxLakh: row.price_max_lakh as number | null,
      places: locality ? [locality] : [],
      groups: row.groups as string[],
      seenCount: row.seen_count as number,
      postedAt: row.posted_at ? new Date(row.posted_at as string).toISOString() : null,
      urgency: null,
      purpose: row.purpose as 'sale' | 'rent',
      houseNo: row.house_no as string | null,
      portion: row.portion as string | null,
      nextFollowUpAt: row.next_followup_at as string | null,
      propertyStatus: row.property_status as string | null,
      lostReason: row.lost_reason as string | null,
      source: row.source as string | null,
      extra: (row.extra ?? {}) as Record<string, string>,
    },
  };
}

/**
 * The parser's listings with the team's own rows laid over them.
 *
 * A listing the team has a row for is replaced by that row, and stays gone if the
 * row was deleted — matched on (post, position in the post), the only identity a
 * listing keeps when its post is re-read. Duplicates have no position, so they
 * replace nothing and simply add a row. Newest first, as the list was before.
 */
export function mergeDeals(listings: Row[], stored: Row[]): Bucketable[] {
  const adopted = new Set(stored.filter((row) => row.source_ord !== null).map((row) => `${row.post_id as string}:${row.source_ord as number}`));
  const own = stored.filter((row) => !row.is_deleted).map(fromStored);
  const parsed = listings.filter((row) => !adopted.has(`${row.post_id as string}:${row.ord as number}`)).map(fromListing);
  const stamp = (item: Bucketable): number => (item.deal.postedAt ? new Date(item.deal.postedAt).getTime() : 0);
  return [...parsed, ...own].sort((a, b) => stamp(b) - stamp(a));
}

/** The numbers a dealer's record answers to, read as the person asking. */
export async function dealerNumbers(ctx: ServiceContext, moduleName: string, recordId: string): Promise<string[]> {
  const record = await getRecord(ctx, moduleName, recordId);
  const module = await registry.requireModule(moduleName);
  return [...mobileIdentities(module, record.values)];
}

/** Read as the person asking: a record they cannot open answers the same refusal as anywhere else. */
export async function dealsOfRecord(ctx: ServiceContext, moduleName: string, recordId: string): Promise<DealerDeals> {
  const numbers = await dealerNumbers(ctx, moduleName, recordId);
  const stored = await storedDeals(recordId);
  const listings = numbers.length ? await derivedListings(numbers) : [];
  return bucketDeals(mergeDeals(listings, stored));
}
