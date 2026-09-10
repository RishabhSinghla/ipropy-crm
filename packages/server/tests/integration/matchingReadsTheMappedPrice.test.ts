/**
 * The price matching compares is the one Budget is mapped to.
 *
 * It used to be `total_price` and `base_price`, read from the top level of the
 * row and nowhere else. Both are built-in columns, so an admin who retires them
 * and creates their own price field — `asking_price` — ends up with a field the
 * record shows, the export contains, the Matching Field Mapping screen points
 * Budget at, and matching cannot see.
 *
 * And it fails in the worst way. The band is `COALESCE(total, base) <= :max`,
 * and NULL fails that comparison rather than passing it, so *every* property
 * drops out for any contact who stated a budget. The whole desk gets "nothing
 * suitable", which reads as bad scoring rather than as a field that moved.
 *
 * This is not hypothetical: production moved its price to `asking_price` on
 * 10 September and mapped Budget to it.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { matchForRecord } from '../../src/ai/matching.js';
import { invalidateMatchingConfig } from '../../src/core/settings/matching.js';

let app: ReturnType<typeof createApp>;
let token = '';
let fieldId = '';
const PRICE_FIELD = `qa_asking_${Date.now().toString(36)}`;
const BUDGET = 20_000_000;
const PRICE = 19_500_000;
let leadId = '';
let propertyId = '';
let previousBudget: string | null = null;
let previousRequirement: { configuration: unknown; preferred_locations: unknown } | null = null;
/** The Budget pair this test re-points, so later files see the CRM it expects. */
let displacedMappings: Record<string, unknown>[] = [];

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  const admin = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`);
  token = (await request(app).post('/api/auth/login')
    .send({ email: admin!.email, password: 'Admin@123' })).body.token;
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_field_mapping WHERE config ? 'qaTest'`);
  if (fieldId) await request(app).delete(`/api/meta/fields/${fieldId}?permanent=true&confirm=true`)
    .set('Authorization', `Bearer ${token}`);
  await db.query(`DELETE FROM ipy_dropped_column WHERE column_name = $1`, [PRICE_FIELD]);
  if (leadId) {
    await db.query(
      `UPDATE ipy_e_leads SET budget = $2, configuration = $3, preferred_locations = $4 WHERE record_id = $1`,
      [leadId, previousBudget,
        JSON.stringify(previousRequirement?.configuration ?? []),
        JSON.stringify(previousRequirement?.preferred_locations ?? [])],
    );
  }
  for (const row of displacedMappings) {
    await db.query(
      `INSERT INTO ipy_field_mapping SELECT * FROM jsonb_populate_record(NULL::ipy_field_mapping, $1::jsonb)
       ON CONFLICT DO NOTHING`, [JSON.stringify(row)]);
  }
  registry.invalidate();
  invalidateMatchingConfig();
});

describe('matching when the price lives in an admin-created field', () => {
  it('finds the property instead of excluding every one of them', async () => {
    const mod = await request(app).get('/api/meta/modules/properties?includeInactive=true')
      .set('Authorization', `Bearer ${token}`).expect(200);
    const created = await request(app).post('/api/meta/modules/properties/fields')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: PRICE_FIELD, label: 'QA asking price', uitype: 'currency', blockId: mod.body.blocks[0].id, config: {} })
      .expect(201);
    fieldId = created.body.id;

    const props = await request(app).get('/api/records/properties?pageSize=1')
      .set('Authorization', `Bearer ${token}`).expect(200);
    propertyId = props.body.rows[0].id;
    await request(app).patch(`/api/records/properties/${propertyId}`)
      .set('Authorization', `Bearer ${token}`).send({ [PRICE_FIELD]: PRICE, status: 'Available' }).expect(200);
    // The built-in columns are emptied, exactly as they are on production.
    await db.query(
      `UPDATE ipy_e_properties SET total_price = NULL, base_price = NULL WHERE record_id = $1`, [propertyId]);

    const lead = await db.queryOne<{ record_id: string; budget: string | null }>(
      `SELECT l.record_id, to_jsonb(l)->>'budget' AS budget FROM ipy_e_leads l JOIN ipy_record r ON r.id = l.record_id
        WHERE r.is_deleted = false
          AND COALESCE((to_jsonb(l)->>'is_converted')::boolean, false) = false
          AND COALESCE(to_jsonb(l)->>'status','') NOT IN ('Junk','Lost') LIMIT 1`);
    leadId = lead!.record_id; previousBudget = lead!.budget;
    /*
      Budget is the only requirement for the duration.

      This test is about *where the price is read from*, not about scoring. A
      lead that also wants 3 BHK in Kharadi drags the score under the match
      floor on an arbitrary property, so the unit is a genuine candidate and
      still absent from the answer — which fails the test for a reason that has
      nothing to do with the bug. Both values go back in `afterAll`.
    */
    const req = await db.queryOne<{ configuration: unknown; preferred_locations: unknown }>(
      `SELECT to_jsonb(l)->'configuration' AS configuration,
              to_jsonb(l)->'preferred_locations' AS preferred_locations
         FROM ipy_e_leads l WHERE l.record_id = $1`, [leadId]);
    previousRequirement = req ?? null;
    await db.query(
      `UPDATE ipy_e_leads SET budget = $2, configuration = '[]'::jsonb, preferred_locations = '[]'::jsonb
        WHERE record_id = $1`, [leadId, BUDGET]);

    // Point Budget at the new field, the way Admin → Matching Setup does —
    // which replaces the existing pair rather than adding a second one.
    displacedMappings = (await db.query<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(fm) AS row FROM ipy_field_mapping fm JOIN ipy_field sf
         ON sf.internal_id = fm.source_field_internal_id
        WHERE sf.name = 'budget' AND fm.purpose = 'matching'`)).rows.map((r) => r.row);
    await db.query(
      `DELETE FROM ipy_field_mapping fm USING ipy_field sf
        WHERE sf.internal_id = fm.source_field_internal_id
          AND sf.name = 'budget' AND fm.purpose = 'matching'`);
    const leadsMeta = await registry.requireModule('leads');
    registry.invalidate();
    const propsMeta = await registry.requireModule('properties');
    const budgetField = leadsMeta.fields.find((f) => f.name === 'budget');
    const priceField = propsMeta.fields.find((f) => f.name === PRICE_FIELD);
    await db.query(
      `INSERT INTO ipy_field_mapping (source_module_id, target_module_id, source_field_internal_id,
         target_field_internal_id, purpose, config, is_active)
       SELECT sm.id, tm.id, $1, $2, 'matching', jsonb_build_object('qaTest', true), true
         FROM ipy_module sm, ipy_module tm WHERE sm.name = 'leads' AND tm.name = 'properties'
       ON CONFLICT DO NOTHING`,
      [budgetField!.internalId, priceField!.internalId],
    );
    invalidateMatchingConfig();

    const matches = await matchForRecord(leadId, { persist: false, withNarrative: false });
    const found = matches.find((m) => m.propertyId === propertyId);
    expect(found, 'the unit is inside the budget band and must be offered').toBeTruthy();
    expect(found!.price, 'and its price must be the mapped one').toBe(PRICE);
  });
});
