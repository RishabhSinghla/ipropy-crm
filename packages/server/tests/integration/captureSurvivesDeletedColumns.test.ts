/**
 * Inbound lead capture, on a database an administrator has pruned.
 *
 * This is the third time this file has silently thrown every inbound enquiry
 * away, and each time it looked identical from outside: the public form answers
 * 200 with its success message, the rep sees no lead, and the only trace is
 * `ipy_lead_inbox.status = 'failed'`.
 *
 * Migration 026 was the first (a name split). The second was a wrong phone
 * format. The third is a column: `l.is_converted` sat on the main path of
 * `captureLead`, production deleted that field, and Postgres answers 42703 for
 * the whole statement — so the website form, Facebook, Google and every portal
 * stopped at once, for any enquiry carrying a phone number or an email.
 *
 * So this deletes the columns first and then runs the real thing. Nothing here
 * asserts a clever outcome: a lead arriving is the entire point.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { captureLead } from '../../src/integrations/leadsources/capture.js';

/** Fields an admin has plausibly removed — production has removed all of these. */
const DROPPED = ['is_converted', 'whatsapp_number', 'description', 'contact_attempts'];
const restored: { column: string; type: string; field: Record<string, unknown> | null }[] = [];

beforeAll(async () => {
  for (const column of DROPPED) {
    const existing = await db.queryOne<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = 'ipy_e_leads' AND column_name = $1`, [column],
    );
    if (!existing) continue;
    // Both halves, the way a permanent delete does it. Dropping the column and
    // leaving the metadata row behind is a state that cannot occur — and it
    // fails for a different reason (the insert still names the column), which
    // would have this test proving the wrong thing.
    const field = await db.queryOne<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(f) AS row FROM ipy_field f JOIN ipy_module m ON m.id = f.module_id
        WHERE m.name = 'leads' AND f.column_name = $1`, [column],
    );
    restored.push({ column, type: existing.data_type, field: field?.row ?? null });
    await db.query(
      `DELETE FROM ipy_field f USING ipy_module m
        WHERE m.id = f.module_id AND m.name = 'leads' AND f.column_name = $1`, [column],
    );
    await db.query(`ALTER TABLE ipy_e_leads DROP COLUMN ${column}`);
  }
  registry.invalidate();
});

afterAll(async () => {
  const SQL: Record<string, string> = {
    boolean: 'BOOLEAN', text: 'TEXT', integer: 'INTEGER', numeric: 'NUMERIC',
  };
  for (const { column, type, field } of restored.reverse()) {
    await db.query(`ALTER TABLE ipy_e_leads ADD COLUMN IF NOT EXISTS ${column} ${SQL[type] ?? 'TEXT'}`);
    if (!field) continue;
    await db.query(
      `INSERT INTO ipy_field SELECT * FROM jsonb_populate_record(NULL::ipy_field, $1::jsonb)
       ON CONFLICT (module_id, name) DO NOTHING`, [JSON.stringify(field)],
    );
  }
  registry.invalidate();
});

describe('lead capture with those fields deleted', () => {
  it('creates the lead instead of failing the enquiry', async () => {
    const mobile = `+9198${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    const result = await captureLead('webform', { probe: true }, {
      source: 'Website', fullName: 'QA Deleted Columns', mobile,
      email: `qa_${Date.now()}@example.com`, message: 'capture on a pruned database',
    } as never);

    expect(result.status, `capture failed: ${result.message}`).toBe('created');
    expect(result.recordId).toBeTruthy();

    await db.query(`DELETE FROM ipy_record WHERE id = $1`, [result.recordId]);
  });

  it('recognises a repeat enquiry rather than raising on the dedupe', async () => {
    const mobile = `+9197${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    const lead = { source: 'Website', fullName: 'QA Repeat', mobile, message: 'first' } as never;
    const first = await captureLead('webform', { probe: true }, lead);
    expect(first.status).toBe('created');

    /*
      A genuinely separate submission from the same person — a different name
      spelling through a different source. An identical payload is caught by
      the replay guard on `ipy_lead_inbox` before it ever reaches the dedupe,
      and returns `recordId: null`, which is right and is not what this test is
      about. It is `findRecentLead` and `enrichExistingLead` that need
      exercising: the two places `is_converted`, `description` and
      `contact_attempts` were named.
    */
    const second = await captureLead('99acres', { probe: true },
      { source: '99acres', fullName: 'QA Repeat Again', mobile, message: 'second' } as never);
    expect(second.status, `repeat enquiry failed: ${second.message}`).toBe('duplicate');
    expect(second.recordId).toBe(first.recordId);

    await db.query(`DELETE FROM ipy_record WHERE id = $1`, [first.recordId]);
  });
});
