/**
 * Buyer matching, when the fields it compares have been deleted.
 *
 * This is the sixth time a hand-written column list has taken a feature down
 * on the owner's own CRM, and the fifth time it was buyer matching. The
 * pattern never varies: an administrator deletes a field they are entitled to
 * delete, a query still names it, Postgres answers 42703 on the whole
 * statement, and the caller cannot tell "no matches" from "it threw". No
 * buyers for a new unit, no units for a buyer, and nothing anywhere saying
 * why. It ran that way for weeks.
 *
 * `columnsThatCanBeDeleted.test.ts` reads the source for named columns, and it
 * passed throughout — because it checks the names against *this* database,
 * where the columns are all present. A test shaped like the developer's laptop
 * cannot find a bug that only exists on a database shaped like production.
 *
 * So this one deletes the fields first and then runs the real thing. Thirteen
 * of them, across both modules, chosen as the ones an admin plausibly removes:
 * the whole comparison should degrade to "no value for that", never to an
 * exception.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { matchForRecord, matchBuyersForProperty, loadRequirement } from '../../src/ai/matching.js';
import { comparablesFor } from '../../src/ai/comparables.js';

const PROPERTY_FIELDS = [
  'facing', 'vastu_compliant', 'corner_unit', 'amenities', 'possession_status',
  'area_unit', 'built_up_area', 'floor',
];
const LEAD_FIELDS = ['purpose', 'possession_timeline', 'lost_reason', 'area', 'area_unit'];

/*
  The suite shares one database and runs its files in order, so anything this
  removes has to come back exactly as it was — column *and* metadata row. An
  earlier draft restored only the column, and three later files failed on a
  module that had quietly lost `floor` and `purpose`. Snapshotting the whole
  `ipy_field` row is the only restoration that cannot drift from what was there.
*/
const dropped: { table: string; column: string; type: string; field: Record<string, unknown> | null }[] = [];

async function dropField(table: string, column: string): Promise<void> {
  const existing = await db.queryOne<{ data_type: string }>(
    `SELECT data_type FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  );
  if (!existing) return;

  const field = await db.queryOne<{ row: Record<string, unknown> }>(
    `SELECT to_jsonb(f) AS row FROM ipy_field f JOIN ipy_module m ON m.id = f.module_id
      WHERE m.table_name = $1 AND f.name = $2`,
    [table, column],
  );
  dropped.push({ table, column, type: existing.data_type, field: field?.row ?? null });

  // Both halves, the way the admin panel does it: the metadata row and the
  // column. Deleting only one of them tests a state that cannot occur.
  await db.query(
    `DELETE FROM ipy_field f USING ipy_module m
      WHERE m.id = f.module_id AND m.table_name = $1 AND f.name = $2`,
    [table, column],
  );
  await db.query(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}

const SQL_TYPE: Record<string, string> = {
  jsonb: 'JSONB', boolean: 'BOOLEAN', text: 'TEXT', integer: 'INTEGER',
  numeric: 'NUMERIC', date: 'DATE', 'timestamp with time zone': 'TIMESTAMPTZ', uuid: 'UUID',
};

beforeAll(async () => {
  for (const column of PROPERTY_FIELDS) await dropField('ipy_e_properties', column);
  for (const column of LEAD_FIELDS) await dropField('ipy_e_leads', column);
  const { registry } = await import('../../src/core/metadata/registry.js');
  registry.invalidate();
});

afterAll(async () => {
  for (const { table, column, type, field } of dropped.reverse()) {
    await db.query(
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "${column}" ${SQL_TYPE[type] ?? 'TEXT'}`,
    );
    if (!field) continue;
    await db.query(
      `INSERT INTO ipy_field SELECT * FROM jsonb_populate_record(NULL::ipy_field, $1::jsonb)
       ON CONFLICT (module_id, name) DO NOTHING`,
      [JSON.stringify(field)],
    );
  }
  const { registry } = await import('../../src/core/metadata/registry.js');
  registry.invalidate();
});

describe('buyer matching with fields deleted', () => {
  it('finds properties for a lead', async () => {
    const lead = await db.queryOne<{ record_id: string }>(
      `SELECT l.record_id FROM ipy_e_leads l JOIN ipy_record r ON r.id = l.record_id
        WHERE r.is_deleted = false LIMIT 1`,
    );
    if (!lead) return; // an empty database has nothing to match, which is not a failure

    // The assertion is that it *answers*. How many it finds depends on the
    // data; that it does not raise is the whole point.
    await expect(matchForRecord(lead.record_id, { persist: false, withNarrative: false }))
      .resolves.toBeInstanceOf(Array);
  });

  it('finds buyers for a property', async () => {
    const property = await db.queryOne<{ record_id: string }>(
      `SELECT p.record_id FROM ipy_e_properties p JOIN ipy_record r ON r.id = p.record_id
        WHERE r.is_deleted = false LIMIT 1`,
    );
    if (!property) return;

    await expect(matchBuyersForProperty(property.record_id, 10))
      .resolves.toBeInstanceOf(Array);
  });

  it('reads a requirement off a lead whose requirement fields are gone', async () => {
    const lead = await db.queryOne<{ record_id: string }>(
      `SELECT l.record_id FROM ipy_e_leads l JOIN ipy_record r ON r.id = l.record_id
        WHERE r.is_deleted = false LIMIT 1`,
    );
    if (!lead) return;

    const req = await loadRequirement(lead.record_id);
    expect(req).not.toBeNull();
    // The deleted ones read as absent, not as an error and not as a wrong value.
    expect(req?.purpose ?? null).toBeNull();
    expect(req?.possessionTimeline ?? null).toBeNull();
    expect(req?.area ?? null).toBeNull();
  });

  it('prices comparables without raising', async () => {
    // `null` is a valid and common answer — three units is not a market. What
    // must not happen is a throw.
    await expect(comparablesFor({ locality: 'Powai', bedrooms: 3, area: null }))
      .resolves.not.toThrow();
  });
});
