/**
 * Editing, duplicating and removing the rows on an Associate's deal tables.
 *
 * A row the team has not touched is only the parser's reading of a WhatsApp post,
 * and the parser rewrites those on every re-read. So the first change to a row
 * *adopts* it: its words are copied into `ipy_associate_deal`, and from then on
 * that row stands in for the listing (see `mergeDeals`). Everything after the
 * adoption is an ordinary update of the team's own row.
 *
 * Permission is the Associate record's: whoever may edit the dealer may edit
 * their deals, and nobody else. A listing is only adopted if it really is one of
 * this dealer's — otherwise anyone could pull any listing in the market onto any
 * record they can edit.
 */
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { assertRecordAccess } from '../permissions/index.js';
import type { ServiceContext } from '../entity/recordService.js';
import { BadRequestError, NotFoundError } from '../../utils/errors.js';
import { derivedListings, dealerNumbers, onceEach } from './dealerDeals.js';
import { label } from './crossMatch.js';
import { matchDeal } from './matchDeal.js';

const text = (max: number) => z.string().trim().max(max).nullable();

/** What the form on a row may change. Strict, so a typo in a key is an error and not a silent no-op. */
export const DEAL_PATCH = z.object({
  purpose: z.enum(['sale', 'rent']),
  houseNo: text(60),
  locality: text(160),
  category: text(80),
  facing: text(40),
  floor: text(60),
  portion: text(60),
  bedrooms: z.number().int().min(0).max(30).nullable(),
  sizeSqYd: z.number().min(0).max(1_000_000).nullable(),
  priceLakh: z.number().min(0).max(10_000_000).nullable(),
  nextFollowUpAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  propertyStatus: text(80),
  lostReason: text(80),
  source: text(80),
  extra: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.string().trim().max(500).nullable()),
}).partial().strict();

export type DealPatch = z.infer<typeof DEAL_PATCH>;

/**
 * Patch key -> column. The only place a column name is chosen, so nothing a caller
 * sends can reach the SQL as an identifier.
 */
const COLUMN_OF: Record<Exclude<keyof DealPatch, 'extra' | 'priceLakh'>, string> = {
  purpose: 'purpose',
  houseNo: 'house_no',
  locality: 'locality',
  category: 'category',
  facing: 'facing',
  floor: 'floor',
  portion: 'portion',
  bedrooms: 'bhk',
  sizeSqYd: 'size_sqyd',
  nextFollowUpAt: 'next_followup_at',
  propertyStatus: 'property_status',
  lostReason: 'lost_reason',
  source: 'source',
};

export type DealRef = { stored: string } | { postId: string; ord: number };

/** A stored row's own id, or `post:<postId>:<position>` for a listing nobody has touched yet. */
export function parseDealRef(ref: string): DealRef {
  const uuid = z.string().uuid();
  if (uuid.safeParse(ref).success) return { stored: ref };
  const parts = /^post:([0-9a-f-]{36}):(\d{1,6})$/i.exec(ref);
  if (parts && uuid.safeParse(parts[1]).success) return { postId: parts[1], ord: Number(parts[2]) };
  throw new BadRequestError('That is not a deal reference');
}

/** The change as `[column, value]` pairs, in the order they will be bound. Pure, for its test. */
export function columnsToSet(patch: DealPatch): Array<[string, unknown]> {
  const pairs: Array<[string, unknown]> = [];
  for (const [key, column] of Object.entries(COLUMN_OF) as Array<[keyof typeof COLUMN_OF, string]>) {
    if (patch[key] === undefined) continue;
    // An emptied box is "not known", never an empty string a filter would then have to special-case.
    const value = patch[key];
    pairs.push([column, value === '' ? null : value]);
  }
  if (patch.priceLakh !== undefined) {
    pairs.push(['price_min_lakh', patch.priceLakh], ['price_max_lakh', patch.priceLakh]);
  }
  return pairs;
}

/** `{a: '1', b: ''}` merged over what is there: an emptied key is removed, so a field taken off the form leaves no ghost behind. */
export function mergeExtra(current: Record<string, string>, change: Record<string, string | null>): Record<string, string> {
  const merged = { ...current };
  for (const [key, value] of Object.entries(change)) {
    if (value === null || value === '') delete merged[key];
    else merged[key] = value;
  }
  if (Object.keys(merged).length > 40) throw new BadRequestError('A deal can carry at most 40 extra fields');
  return merged;
}

async function assertMayEdit(ctx: ServiceContext, moduleName: string, recordId: string): Promise<string[]> {
  if (moduleName !== 'associates') throw new BadRequestError('Deal tables belong to the Associates module');
  await assertRecordAccess(ctx, moduleName, recordId, 'edit');
  return dealerNumbers(ctx, moduleName, recordId);
}

/** The team's own row for this deal, creating it from the listing the first time. */
async function storedIdFor(ctx: ServiceContext, recordId: string, numbers: string[], ref: DealRef): Promise<string> {
  if ('stored' in ref) {
    const own = await db.queryOne<{ id: string }>(
      `SELECT id FROM ipy_associate_deal WHERE id = $1 AND record_id = $2 AND NOT is_deleted`,
      [ref.stored, recordId],
    );
    if (!own) throw new NotFoundError('That deal is not on this record');
    return own.id;
  }

  const [listing] = numbers.length
    ? await derivedListings(numbers, 'AND l.post_id = $3::uuid AND l.ord = $4::int', [ref.postId, ref.ord])
    : [];
  if (!listing) throw new NotFoundError('That deal is not on this record');

  const created = await db.queryOne<{ id: string; is_deleted: boolean }>(
    `INSERT INTO ipy_associate_deal
       (record_id, post_id, source_ord, kind, purpose, summary, body, groups, seen_count, posted_at,
        locality, category, project, facing, floor, bhk, size_sqyd, price_min_lakh, price_max_lakh, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     ON CONFLICT (record_id, post_id, source_ord) WHERE source_ord IS NOT NULL
       DO UPDATE SET updated_at = now()
     RETURNING id, is_deleted`,
    [
      recordId, ref.postId, ref.ord, listing.kind, listing.purpose ?? 'sale', listing.summary, listing.body,
      listing.groups, listing.seen_count, listing.posted_at,
      onceEach(((listing.place_keys as string[]) ?? []).map(label)).join(', ') || null,
      listing.category, listing.project, listing.facing, listing.floor, listing.bhk, listing.size_sqyd,
      listing.price_min_lakh, listing.price_max_lakh, ctx.user.id,
    ],
  );
  if (!created || created.is_deleted) throw new NotFoundError('That deal is not on this record');
  return created.id;
}

export async function updateDeal(ctx: ServiceContext, moduleName: string, recordId: string, ref: string, patch: DealPatch): Promise<string> {
  const numbers = await assertMayEdit(ctx, moduleName, recordId);
  const id = await storedIdFor(ctx, recordId, numbers, parseDealRef(ref));

  const pairs = columnsToSet(patch);
  const params: unknown[] = [id];
  const sets = pairs.map(([column, value]) => { params.push(value); return `${column} = $${params.length}`; });

  if (patch.extra) {
    const current = await db.queryOne<{ extra: Record<string, string> }>(`SELECT extra FROM ipy_associate_deal WHERE id = $1`, [id]);
    params.push(JSON.stringify(mergeExtra(current?.extra ?? {}, patch.extra)));
    sets.push(`extra = $${params.length}::jsonb`);
  }
  if (!sets.length) return id;

  await db.query(`UPDATE ipy_associate_deal SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
  return id;
}

/** A copy that replaces nothing, so the original and the duplicate are both on the list. */
export async function duplicateDeal(ctx: ServiceContext, moduleName: string, recordId: string, ref: string): Promise<string> {
  const numbers = await assertMayEdit(ctx, moduleName, recordId);
  const sourceId = await storedIdFor(ctx, recordId, numbers, parseDealRef(ref));
  const copy = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_associate_deal
       (record_id, post_id, source_ord, kind, purpose, summary, body, groups, seen_count, posted_at,
        house_no, locality, category, project, facing, floor, portion, bhk, size_sqyd, price_min_lakh, price_max_lakh,
        next_followup_at, property_status, lost_reason, source, extra, created_by)
     SELECT record_id, post_id, NULL, kind, purpose, summary, body, groups, seen_count, posted_at,
            house_no, locality, category, project, facing, floor, portion, bhk, size_sqyd, price_min_lakh, price_max_lakh,
            next_followup_at, property_status, lost_reason, source, extra, $2
       FROM ipy_associate_deal WHERE id = $1
     RETURNING id`,
    [sourceId, ctx.user.id],
  );
  if (!copy) throw new NotFoundError('That deal is not on this record');
  return copy.id;
}

/** Hidden, not erased: the row keeps a listing from coming back when its post is re-read. */
export async function deleteDeal(ctx: ServiceContext, moduleName: string, recordId: string, ref: string): Promise<void> {
  const numbers = await assertMayEdit(ctx, moduleName, recordId);
  const id = await storedIdFor(ctx, recordId, numbers, parseDealRef(ref));
  await db.query(`UPDATE ipy_associate_deal SET is_deleted = true, updated_at = now() WHERE id = $1`, [id]);
}

/** Most posts one request may ask about: each is a few queries, and a table shows a page at a time. */
export const MATCH_COUNT_LIMIT = 40;

/** How many of our own records each post fits — only the ones the person asking may open. */
export async function matchCounts(postIds: string[], scope: Parameters<typeof matchDeal>[1]): Promise<Record<string, number>> {
  const unique = [...new Set(postIds)].slice(0, MATCH_COUNT_LIMIT);
  const counts: Record<string, number> = {};
  for (const id of unique) counts[id] = (await matchDeal(id, scope)).length;
  return counts;
}
