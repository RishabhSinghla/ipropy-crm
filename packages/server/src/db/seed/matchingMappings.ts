/**
 * The default Contact ↔ Property matching pairs, as data.
 *
 * Migration 120 seeds these too, and that is the right place for a CRM that
 * already has fields — production's were created years of edits ago. It is the
 * wrong place for a new one: migrations run before the seed, so on a fresh
 * database `ipy_field` is empty when the migration looks, and it inserts
 * nothing. The pairs then exist only as `DEFAULT_MATCHING_CONFIG`, a constant
 * an admin cannot see or edit — which is the opposite of the point.
 *
 * So this runs after the modules are in place and does the same work. It is
 * create-only, like everything else in the seed: a pair an admin has since
 * removed must stay removed, and `docker-entrypoint.sh` re-seeds on every cold
 * start.
 *
 * Resolved on `column_name`, through a list of candidates. See migration 120
 * for why the name is not usable and why one list does not fit both databases.
 */
import type { Tx } from '../pool.js';

/**
 * Candidates are tried best-first and the first that exists wins. The lists
 * lead with what production holds *today* and keep the older names behind it,
 * because this has to seed the same four intentions on a database of any age.
 *
 * They were wrong until 2026-09-11: price was looked for under `base_price`,
 * `demand` and `total_price`, and size under `area`, `carpet_area` and
 * `built_up_area` — production has permanently deleted all six. Its price is
 * `asking_price` and its size `area_size`, both admin-created, so both live in
 * `custom_fields` and their `column_name` is the JSONB key. A re-seed or a
 * re-created field therefore mapped location and BHK and silently nothing
 * else, which is the failure migration 129 was written for, one field set
 * later.
 *
 * `types` is the guard that makes a wrong answer impossible rather than
 * unlikely. An amount field carries a companion holding its unit — `area_size`
 * is `area`, `area_size_unit` is `string` — and on production the size field's
 * JSONB key is literally `area_unit`, which reads exactly like that companion.
 * Matching size against a column of the word "Sq Ft" would score every unit
 * identically and report a confident percentage while doing it.
 */
const DEFAULT_PAIRS: {
  intent: string;
  source: string[];
  target: string[];
  types: string[];
}[] = [
  {
    intent: 'budget',
    source: ['budget'],
    target: ['asking_price', 'base_price', 'demand', 'total_price'],
    types: ['currency', 'number', 'decimal', 'integer', 'double'],
  },
  {
    intent: 'bhk',
    source: ['configuration'],
    target: ['configuration', 'bedrooms'],
    // `multipicklist` is not a stray: the buyer side is genuinely multi — a
    // family will take a 2 BHK or a 3 BHK — while a unit is exactly one. Its
    // absence here is why BHK, the heaviest term in the score, resolved to
    // nothing on production's field set.
    types: ['picklist', 'multipicklist', 'string', 'text', 'integer', 'number'],
  },
  {
    intent: 'location',
    source: ['preferred_locations'],
    target: ['locality', 'city'],
    types: ['string', 'text', 'picklist', 'multipicklist'],
  },
  {
    intent: 'size',
    source: ['area_size', 'area', 'area_unit'],
    target: ['area_size', 'carpet_area', 'area', 'built_up_area'],
    types: ['area', 'number', 'decimal', 'integer', 'double'],
  },
];

export async function seedMatchingMappings(tx: Tx): Promise<number> {
  // Anything already configured — seeded before, or mapped by hand in
  // Admin → Matching Setup — means this has run its course.
  const existing = await tx.queryOne<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM ipy_field_mapping WHERE purpose = 'matching'`,
  );
  if ((existing?.n ?? 0) > 0) return 0;

  let created = 0;
  for (const pair of DEFAULT_PAIRS) {
    const res = await tx.query(
      `INSERT INTO ipy_field_mapping (
         source_module_id, target_module_id, source_field_internal_id,
         target_field_internal_id, purpose, config, is_active
       )
       SELECT sm.id, tm.id, sf.internal_id, tf.internal_id, 'matching',
              jsonb_build_object('seeded', true, 'intent', $3::text), true
         FROM ipy_module sm
         JOIN ipy_module tm ON tm.name = 'properties'
        CROSS JOIN LATERAL (
          SELECT f.internal_id FROM ipy_field f
           WHERE f.module_id = sm.id AND f.is_active AND f.column_name = ANY ($1::text[])
             AND f.uitype = ANY ($4::text[])
           ORDER BY array_position($1::text[], f.column_name) LIMIT 1
        ) sf
        CROSS JOIN LATERAL (
          SELECT f.internal_id FROM ipy_field f
           WHERE f.module_id = tm.id AND f.is_active AND f.column_name = ANY ($2::text[])
             AND f.uitype = ANY ($4::text[])
           ORDER BY array_position($2::text[], f.column_name) LIMIT 1
        ) tf
        WHERE sm.name = 'leads'
       ON CONFLICT DO NOTHING`,
      [pair.source, pair.target, pair.intent, pair.types],
    );
    created += res.rowCount ?? 0;
  }
  return created;
}
