/**
 * Assigned To can be changed after somebody has renamed it.
 *
 * `owner_id` is not on the payload table — it is a column on `ipy_record`,
 * marked with `config.__record`. Everything that wrote it was keyed on the
 * literal string 'owner_id', which is right until an administrator renames the
 * field, and renaming is something this CRM promises they may do.
 *
 * On production it had been renamed to `assigned_to`, and the failure was
 * split in a way that made it very hard to report: **reads worked**, because
 * values come out of the row by column, so the right person's name showed on
 * the record — and **every write failed**, because the payload split then tried
 * to set `ipy_e_leads.owner_id`, a column that is not there. The field showed
 * the owner and would not change, with no error worth reading.
 *
 * His words: "why am I not able to change the value of this field".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { recordService } from '../../src/core/entity/recordService.js';

const RENAMED = 'assigned_to';
let fieldId: string | null = null;
let originalName = 'owner_id';
let ctx: { user: { id: string; isAdmin: boolean }; system: boolean };
let recordId: string | null = null;
let otherUserId: string | null = null;

beforeAll(async () => {
  const field = await db.queryOne<{ id: string; name: string }>(
    `SELECT f.id, f.name FROM ipy_field f JOIN ipy_module m ON m.id = f.module_id
      WHERE m.name = 'leads' AND f.column_name = 'owner_id' AND f.storage = 'column' LIMIT 1`,
  );
  if (!field) return;
  fieldId = field.id;
  originalName = field.name;

  await db.query(`UPDATE ipy_field SET name = $2 WHERE id = $1`, [fieldId, RENAMED]);
  registry.invalidate();

  const users = await db.query<{ id: string }>(
    `SELECT id FROM ipy_user WHERE is_active = true ORDER BY created_at LIMIT 2`,
  );
  ctx = { user: { id: users.rows[0].id, isAdmin: true }, system: true } as never;
  otherUserId = users.rows[1]?.id ?? users.rows[0].id;

  const created = await recordService.createRecord(ctx as never, 'leads', {
    full_name: `Owner rename ${Date.now()}`, mobile: '9812345699',
  }, { skipDuplicateCheck: true, skipWorkflow: true });
  recordId = created.id;
});

afterAll(async () => {
  if (recordId) await db.query(`DELETE FROM ipy_record WHERE id = $1`, [recordId]);
  if (fieldId) await db.query(`UPDATE ipy_field SET name = $2 WHERE id = $1`, [fieldId, originalName]);
  registry.invalidate();
});

describe('the owner field under a name the admin chose', () => {
  it('saves a new owner sent under the renamed field', async () => {
    if (!fieldId || !recordId) return;

    // Exactly what the record page sends: the field's *current* name.
    await recordService.updateRecord(ctx as never, 'leads', recordId,
      { [RENAMED]: otherUserId }, { skipWorkflow: true } as never);

    const row = await db.queryOne<{ owner_id: string }>(
      `SELECT owner_id FROM ipy_record WHERE id = $1`, [recordId]);
    // Before the fix this raised `column "owner_id" of relation
    // "ipy_e_leads" does not exist`, and the owner never moved.
    expect(row?.owner_id).toBe(otherUserId);
  });

  it('reads it back under that same name', async () => {
    if (!fieldId || !recordId) return;
    const envelope = await recordService.getRecord(ctx as never, 'leads', recordId);
    expect(envelope.ownerId).toBe(otherUserId);
  });

  it('can still be filtered on, which is the read half of the same bug', async () => {
    if (!fieldId) return;
    // `fieldExpr` resolved this through RECORD_FIELD_MAP[field.name], so a
    // renamed field fell through to `e.owner_id` on the payload table.
    await expect(recordService.listRecords(ctx as never, 'leads', {
      filter: { logic: 'AND', conditions: [{ field: RENAMED, operator: 'equals', value: otherUserId }] },
      pageSize: 5,
    } as never)).resolves.toBeTruthy();
  });
});
