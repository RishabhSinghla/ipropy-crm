/**
 * What one dealer has posted in the groups, as four lists on their record.
 *
 * An Associate is a dealer; the deals they post are the reason they are worth
 * having in the CRM. Sorted the way a rep thinks about them: what they have to
 * sell, what they have to let, what their buyers want, what their tenants want.
 * It is the same table the Dealer groups page reads — a deal is stored once —
 * so nothing here is a second copy to keep in step.
 *
 * Found by the dealer's number (the last ten digits, as every other match in
 * this CRM). A record whose number nobody has posted under simply has four
 * empty lists.
 */
import { db } from '../../db/pool.js';
import { registry } from '../metadata/registry.js';
import { getRecord, type ServiceContext } from '../entity/recordService.js';
import { mobileIdentities } from '../entity/mobileIdentity.js';

export interface DealerDeal {
  id: string;
  body: string;
  category: string | null;
  bhk: number | null;
  sizeSqYd: number | null;
  priceMinLakh: number | null;
  priceMaxLakh: number | null;
  places: string[];
  groups: string[];
  seenCount: number;
  postedAt: string | null;
  urgency: number | null;
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
const DAYS = 365;

/** The business's own spelling first ("Sector 78"); the reader's lower-cased twin of it is dropped. */
export function onceEach(names: string[]): string[] {
  const seen = new Set<string>();
  return names.filter((name) => !seen.has(name.toLowerCase()) && !!seen.add(name.toLowerCase()));
}

export function bucketDeals(rows: Array<{ kind: string; purpose: string | null; deal: DealerDeal }>): DealerDeals {
  const result: DealerDeals = { forSale: [], buyerRequirements: [], forRent: [], tenantRequirements: [], truncated: false };
  for (const { kind, purpose, deal } of rows) {
    const rent = purpose === 'rent';
    const list = kind === 'have' ? (rent ? result.forRent : result.forSale) : (rent ? result.tenantRequirements : result.buyerRequirements);
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
    `SELECT id, body, kind, purpose, category, bhk, size_sqyd, price_min_lakh, price_max_lakh,
            places, localities, groups, seen_count, urgency, coalesce(last_posted_at, created_at) AS posted_at
       FROM ipy_market_post
      WHERE poster_phone = ANY($1::text[]) AND NOT is_noise AND kind IN ('have', 'want')
        AND coalesce(last_posted_at, created_at) > now() - make_interval(days => $2::int)
      ORDER BY coalesce(last_posted_at, created_at) DESC
      LIMIT 1000`,
    [numbers, DAYS],
  );
  return bucketDeals(rows.rows.map((row) => ({
    kind: row.kind as string,
    purpose: row.purpose as string | null,
    deal: {
      id: row.id as string,
      body: row.body as string,
      category: row.category as string | null,
      bhk: row.bhk as number | null,
      sizeSqYd: row.size_sqyd as number | null,
      priceMinLakh: row.price_min_lakh as number | null,
      priceMaxLakh: row.price_max_lakh as number | null,
      places: onceEach([...(row.localities as string[]), ...(row.places as string[])]),
      groups: row.groups as string[],
      seenCount: row.seen_count as number,
      postedAt: row.posted_at ? new Date(row.posted_at as string).toISOString() : null,
      urgency: row.urgency as number | null,
    },
  })));
}
