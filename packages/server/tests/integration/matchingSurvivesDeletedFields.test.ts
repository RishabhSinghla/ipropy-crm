/**
 * Buyer matching, with the two deleted fields actually deleted.
 *
 * `city` and `project_name` were removed from this CRM on purpose. Both matching
 * queries named them as columns, and naming a dropped column is a Postgres
 * 42703, which throws. So on production both directions of matching — buyers for
 * a new unit, units for a buyer — raised on every call.
 *
 * The failure was invisible from outside. Callers treat "no matches" and "it
 * threw" identically, so the feature reads as a matching engine that never finds
 * anything rather than one that never ran.
 *
 * This drops the columns for real. Reading the SQL was how the bug survived
 * three separate occurrences.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { matchBuyersForProperty, matchForRecord } from '../../src/ai/matching.js';

const DELETABLE = ['city', 'project_name'] as const;
const restore: { name: string; type: string }[] = [];
let propertyId: string;
let leadId: string;

beforeAll(async () => {
  const property = await db.queryOne<{ record_id: string }>(
    `SELECT p.record_id FROM ipy_e_properties p
       JOIN ipy_record r ON r.id = p.record_id
      WHERE r.is_deleted = false LIMIT 1`,
  );
  const lead = await db.queryOne<{ record_id: string }>(
    `SELECT l.record_id FROM ipy_e_leads l
       JOIN ipy_record r ON r.id = l.record_id
      WHERE r.is_deleted = false LIMIT 1`,
  );
  if (!property || !lead) throw new Error('need a seeded property and lead');
  propertyId = property.record_id;
  leadId = lead.record_id;

  for (const name of DELETABLE) {
    const column = await db.queryOne<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = 'ipy_e_properties' AND column_name = $1`,
      [name],
    );
    if (column) {
      restore.push({ name, type: column.data_type === 'text' ? 'TEXT' : 'VARCHAR(255)' });
      await db.query(`ALTER TABLE ipy_e_properties DROP COLUMN ${name}`);
    }
  }
});

afterAll(async () => {
  for (const { name, type } of restore) {
    await db.query(`ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS ${name} ${type}`);
  }
});

describe('matching with city and project_name deleted', () => {
  it('finds properties for a buyer without throwing', async () => {
    // The assertion is that it *returns*. An empty list is a legitimate answer;
    // a 42703 is not, and before the fix that is all this could produce.
    await expect(matchForRecord(leadId)).resolves.toBeInstanceOf(Array);
  });

  it('finds buyers for a property without throwing', async () => {
    await expect(matchBuyersForProperty(propertyId)).resolves.toBeInstanceOf(Array);
  });

  it('really did drop the columns, so the two above mean something', async () => {
    // Guard against the test quietly passing because the ALTERs did not run.
    for (const name of DELETABLE) {
      const column = await db.queryOne(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name = 'ipy_e_properties' AND column_name = $1`,
        [name],
      );
      expect(column, `${name} should be dropped for this suite`).toBeNull();
    }
  });
});
