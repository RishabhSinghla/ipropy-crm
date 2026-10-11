/**
 * The other direction in time: a new buyer arrives, and the dealer groups
 * already had something for them.
 *
 * Uploading a group alerts owners about *fresh deals* (feed.ts). But the
 * commonest miss runs the other way round — a dealer posted a 3 BHK in
 * Greenfields on Monday, a buyer for exactly that calls on Thursday, and
 * nobody remembers Monday's post. So when a record is created that states
 * where it wants to buy, the last 30 days of sellers' deals are checked once
 * and its owner hears how many fit.
 *
 * Shaped by the record, not by a module name: anything carrying
 * `preferred_locations` is somebody looking to buy. Runs after commit, off the
 * event bus, and never throws — a missed alert must not touch the save.
 */
import { db } from '../../db/pool.js';
import { bus, type RecordEventPayload } from '../events/bus.js';
import { notify } from '../notifications/index.js';
import { logger } from '../../utils/logger.js';

const LOOK_BACK_DAYS = 30;

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return value.split(',').map((v) => v.trim()).filter(Boolean);
  return [];
}

/** Sellers' deals that fit what this buyer asked for. Exported for its test. */
export async function dealsForBuyer(values: Record<string, unknown>): Promise<number> {
  const places = list(values.preferred_locations);
  if (!places.length) return 0;
  const sizes = list(values.configuration)
    .map((size) => Number(/(\d+)\s*bhk/i.exec(size)?.[1]))
    .filter((n) => n > 0);
  const budget = Number(values.budget) > 0 ? Number(values.budget) : null;

  const found = await db.queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM ipy_market_post
      WHERE kind = 'have'
        AND coalesce(last_posted_at, created_at) > now() - make_interval(days => $1::int)
        AND localities && $2::text[]
        AND (cardinality($3::int[]) = 0 OR bhk IS NULL OR bhk = ANY($3::int[]))
        AND ($4::numeric IS NULL OR price_min_lakh IS NULL OR price_min_lakh * 100000 <= $4::numeric * 1.15)`,
    [LOOK_BACK_DAYS, places, sizes, budget],
  );
  return found?.n ?? 0;
}

async function onCreated(payload: RecordEventPayload): Promise<void> {
  const fits = await dealsForBuyer(payload.record);
  if (!fits) return;
  const owner = await db.queryOne<{ owner_id: string | null; label: string }>(
    `SELECT owner_id, label FROM ipy_record WHERE id = $1`, [payload.recordId],
  );
  if (!owner?.owner_id) return;
  const place = list(payload.record.preferred_locations)[0]!;
  await notify({
    userId: owner.owner_id,
    kind: 'market_match',
    title: `${fits} dealer-group deal${fits === 1 ? '' : 's'} may suit ${owner.label}`,
    body: `Posted in the last ${LOOK_BACK_DAYS} days in ${place}${fits > 1 || list(payload.record.preferred_locations).length > 1 ? ' and nearby choices' : ''}.`,
    link: `/market?kind=have&locality=${encodeURIComponent(place)}`,
    recordId: payload.recordId,
  });
}

export function registerMarketListeners(): void {
  bus.on('record.created', async (payload) => {
    try {
      await onCreated(payload);
    } catch (err) {
      logger.warn({ err, recordId: payload.recordId }, 'market: checking a new buyer against dealer deals failed');
    }
  });
}
