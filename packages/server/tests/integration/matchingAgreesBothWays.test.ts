/**
 * The two directions must agree about the same pair.
 *
 * "Find matching properties" on a contact and "Find matching clients" on a
 * property are the same question asked from opposite ends, and a CRM that
 * answers them differently is worse than one that answers neither: a rep looks
 * at the unit, sees no buyers, and moves on — while the buyer's own screen has
 * been recommending that unit at 90%.
 *
 * They disagreed. Forward asks "is the price within ±grace of the budget",
 * which is price ∈ [b(1−g), b(1+g)]. The reverse applied the same
 * multiplicative band to the price — budget ∈ [p(1−g), p(1+g)] — instead of
 * inverting it to [p/(1+g), p/(1−g)]. Those are different intervals, and the
 * difference falls the wrong way: a buyer whose budget *exceeds* the asking
 * price was excluded. A ₹2.6 Cr buyer never appeared against the ₹2.34 Cr flat
 * that scored 90 for them in the other direction — the person with more money
 * than the unit costs being the best buyer it has.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { matchForRecord, matchBuyersForProperty } from '../../src/ai/matching.js';
import { scoringThresholds } from '../../src/core/settings/scoring.js';
import { invalidateMatchingConfig } from '../../src/core/settings/matching.js';

beforeAll(async () => {
  await registry.warmup();
  /*
    Both caches, deliberately.

    `matchingConfig` holds field *internal ids*, and earlier files in this
    suite delete and re-create `ipy_field` rows — so a cache warmed before them
    resolves none of its pairs, the mapped price falls back to the built-in
    column, and this file fails for a reason that has nothing to do with it.
  */
  registry.invalidate();
  invalidateMatchingConfig();
});

describe('forward and reverse matching', () => {
  it('a property a contact matches must list that contact back', async () => {
    const { matchFloor } = await scoringThresholds();

    /*
      A live lead that states a budget.

      Two exclusions are the reverse direction being right rather than
      inconsistent, and the invariant has to respect them: somebody who has
      already bought is not a buyer, and Junk is never one. The forward
      direction will still happily score properties for a converted contact —
      you are allowed to look — so picking the largest budget in the table
      lands on a Converted lead and fails a test asserting the wrong thing.
    */
    const lead = await db.queryOne<{ record_id: string }>(
      `SELECT l.record_id FROM ipy_e_leads l JOIN ipy_record r ON r.id = l.record_id
        WHERE r.is_deleted = false
          AND ipy_try_numeric(to_jsonb(l)->>'budget') IS NOT NULL
          AND COALESCE((to_jsonb(l)->>'is_converted')::boolean, false) = false
          AND COALESCE(to_jsonb(l)->>'status', '') NOT IN ('Junk', 'Lost')
        ORDER BY ipy_try_numeric(to_jsonb(l)->>'budget') DESC LIMIT 1`,
    );
    if (!lead) return; // nothing to prove on a database with no stated budgets

    const forward = await matchForRecord(lead.record_id, { persist: false, withNarrative: false });
    const strong = forward.filter((m) => m.score >= matchFloor);
    if (!strong.length) return; // no confident match either way is consistent

    for (const match of strong.slice(0, 3)) {
      const buyers = await matchBuyersForProperty(match.propertyId, 100);
      expect(
        buyers.some((b) => b.recordId === lead.record_id),
        `${match.propertyLabel} scores ${match.score} for this contact going forward, `
        + `but the contact is not among the ${buyers.length} buyers it lists in reverse`,
      ).toBe(true);
    }
  });

  it('agrees at the edge of the price band, where the two used to diverge', async () => {
    /*
      The disagreement lived in a narrow window that seeded data does not
      happen to land in, so this builds it.

      Forward keeps a property when price ∈ [0.9·budget, 1.1·budget]. The old
      reverse kept a buyer when budget ∈ [0.9·price, 1.1·price]. A price at
      0.9008 × budget satisfies the first and fails the second — the buyer can
      comfortably afford the unit, which is the one case you least want to
      drop. ₹2.6 Cr against ₹2.34 Cr is exactly the pair that exposed it.

      The pair is taken from a match the forward direction already makes, so
      the unit is certain to be among the candidates it scores; only the two
      numbers are moved.
    */
    const BUDGET = 26_000_000;
    const PRICE = 23_420_000; // 0.9008 × budget

    const lead = await db.queryOne<{ record_id: string; budget: string | null }>(
      `SELECT l.record_id, to_jsonb(l)->>'budget' AS budget
         FROM ipy_e_leads l JOIN ipy_record r ON r.id = l.record_id
        WHERE r.is_deleted = false
          AND ipy_try_numeric(to_jsonb(l)->>'budget') IS NOT NULL
          AND COALESCE((to_jsonb(l)->>'is_converted')::boolean, false) = false
          AND COALESCE(to_jsonb(l)->>'status', '') NOT IN ('Junk', 'Lost')
        ORDER BY ipy_try_numeric(to_jsonb(l)->>'budget') DESC LIMIT 1`,
    );
    if (!lead) return;
    const seedMatches = await matchForRecord(lead.record_id, { persist: false, withNarrative: false });
    if (!seedMatches.length) return;
    const targetId = seedMatches[0].propertyId;

    const property = await db.queryOne<{ total_price: string | null; base_price: string | null }>(
      `SELECT to_jsonb(p)->>'total_price' AS total_price, to_jsonb(p)->>'base_price' AS base_price
         FROM ipy_e_properties p WHERE p.record_id = $1`, [targetId],
    );
    const hasTotal = property?.total_price !== null && property?.total_price !== undefined;

    try {
      await db.query(`UPDATE ipy_e_leads SET budget = $2 WHERE record_id = $1`, [lead.record_id, BUDGET]);
      await db.query(
        hasTotal
          ? `UPDATE ipy_e_properties SET total_price = $2, base_price = $2 WHERE record_id = $1`
          : `UPDATE ipy_e_properties SET base_price = $2 WHERE record_id = $1`,
        [targetId, PRICE],
      );

      const forward = await matchForRecord(lead.record_id, { persist: false, withNarrative: false });
      expect(forward.find((m) => m.propertyId === targetId),
        'the unit is inside the forward price band and should still be offered').toBeTruthy();

      const buyers = await matchBuyersForProperty(targetId, 200);
      expect(buyers.some((b) => b.recordId === lead.record_id),
        'a buyer who can comfortably afford the unit must appear against it in reverse').toBe(true);
    } finally {
      await db.query(`UPDATE ipy_e_leads SET budget = $2 WHERE record_id = $1`, [lead.record_id, lead.budget]);
      // Bound to exactly what each statement names. The `base_price`-only
      // branch used to leave `$2` bound and unreferenced, which Postgres
      // refuses outright — so any real failure in the block above came back as
      // "could not determine data type of parameter $2" from the cleanup,
      // pointing at the wrong line and hiding what actually broke.
      await db.query(
        hasTotal
          ? `UPDATE ipy_e_properties SET total_price = $2, base_price = $3 WHERE record_id = $1`
          : `UPDATE ipy_e_properties SET base_price = $2 WHERE record_id = $1`,
        hasTotal
          ? [targetId, property?.total_price ?? null, property?.base_price ?? null]
          : [targetId, property?.base_price ?? null],
      );
    }
  });
});
