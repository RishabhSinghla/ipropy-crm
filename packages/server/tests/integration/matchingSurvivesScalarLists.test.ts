/**
 * Matching, when a "list" field holds a single string.
 *
 * Both of these were live on production and neither is a mis-ranking — they
 * are the feature being dead while the screen says nothing useful:
 *
 *   TypeError: req.configurations?.map is not a function        → 500
 *   malformed array literal: "Greenfield Colony"  (22P02)       → 400
 *
 * One cause. `configuration` and `preferred_locations` were read with
 * `as string[]`, which is a cast and checks nothing, so a lead whose value is a
 * plain string — a retyped field, an import, a single-select — reached `.map`
 * and a `::text[]` cast. It failed per *lead*, which is why it looked
 * intermittent and unreportable.
 *
 * Lead scoring failed on the same records for a different reason: it named
 * `p.total_price` and `p.configuration`, both deleted from Properties, so every
 * call raised 42703 into a workflow task that logs and carries on.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { matchForRecord, loadRequirement } from '../../src/ai/matching.js';
import { scoreLead } from '../../src/ai/leadScoring.js';

let recordId: string | null = null;
let before: { configuration: unknown; preferred_locations: unknown } | null = null;

beforeAll(async () => {
  const lead = await db.queryOne<{ record_id: string; configuration: unknown; preferred_locations: unknown }>(
    `SELECT l.record_id, l.configuration, l.preferred_locations
       FROM ipy_e_leads l JOIN ipy_record r ON r.id = l.record_id
      WHERE r.is_deleted = false LIMIT 1`,
  );
  if (!lead) return;
  recordId = lead.record_id;
  before = { configuration: lead.configuration, preferred_locations: lead.preferred_locations };

  // Exactly what production held: one scalar string in each, not an array.
  await db.query(
    `UPDATE ipy_e_leads
        SET configuration = to_jsonb('3 BHK'::text),
            preferred_locations = to_jsonb('Greenfield Colony'::text)
      WHERE record_id = $1`,
    [recordId],
  );
});

afterAll(async () => {
  if (!recordId || !before) return;
  await db.query(
    `UPDATE ipy_e_leads SET configuration = $2, preferred_locations = $3 WHERE record_id = $1`,
    [recordId, JSON.stringify(before.configuration ?? null), JSON.stringify(before.preferred_locations ?? null)],
  );
});

describe('a lead whose list fields hold a single string', () => {
  it('reads the requirement as lists rather than characters', async () => {
    if (!recordId) return;
    const req = await loadRequirement(recordId);
    expect(req).not.toBeNull();
    expect(req!.configurations).toEqual(['3 BHK']);
    expect(req!.locations).toEqual(['Greenfield Colony']);
  });

  it('finds matching properties instead of raising', async () => {
    if (!recordId) return;
    // Answering is the assertion. Before the fix this threw a TypeError on the
    // way in and 22P02 out of Postgres on the way past it.
    await expect(matchForRecord(recordId, { persist: false, withNarrative: false }))
      .resolves.toBeInstanceOf(Array);
  });

  it('scores the lead without naming a deleted column', async () => {
    if (!recordId) return;
    const result = await scoreLead(recordId, { withNarrative: false });
    expect(result).toBeTruthy();
    expect(typeof result!.score).toBe('number');
  });
});
