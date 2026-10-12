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
  /** The listing — one property. */
  id: string;
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

/** Read as the person asking: a record they cannot open answers the same refusal as anywhere else. */
export async function dealsOfRecord(ctx: ServiceContext, moduleName: string, recordId: string): Promise<DealerDeals> {
  const record = await getRecord(ctx, moduleName, recordId);
  const module = await registry.requireModule(moduleName);
  const numbers = [...mobileIdentities(module, record.values)];
  if (!numbers.length) return bucketDeals([]);

  const rows = await db.query<Record<string, unknown>>(
    `SELECT l.id, l.post_id, l.kind, l.purpose, l.summary, l.category, l.project, l.facing, l.floor, l.bhk, l.size_sqyd, l.price_min_lakh, l.price_max_lakh,
            l.place_keys, p.body, p.groups, p.seen_count, p.urgency, coalesce(p.last_posted_at, p.created_at) AS posted_at
       FROM ipy_market_listing l JOIN ipy_market_post p ON p.id = l.post_id
      WHERE p.poster_phone = ANY($1::text[]) AND NOT p.is_noise
        AND coalesce(p.last_posted_at, p.created_at) > now() - make_interval(days => $2::int)
      ORDER BY coalesce(p.last_posted_at, p.created_at) DESC, l.ord
      LIMIT 1000`,
    [numbers, DAYS],
  );
  return bucketDeals(rows.rows.map((row) => ({
    kind: row.kind as string,
    purpose: row.purpose as string | null,
    deal: {
      id: row.id as string,
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
    },
  })));
}
