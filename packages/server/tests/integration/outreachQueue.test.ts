/**
 * The send queue, against a real database.
 *
 * The bug this exists for: delete a lead, and the message queued for them is
 * still sitting in Outreach waiting to be sent. Deleting a record is a *soft*
 * delete — the row stays in `ipy_record` with `is_deleted = true` — so the
 * `ON DELETE CASCADE` on `ipy_device_send.record_id` never fires and the queue,
 * which never joined `ipy_record`, went on offering the message. Fourteen of
 * the fifty-nine messages in the developer's own queue were for leads that no
 * longer existed.
 *
 * Written against the service rather than the routes: the assignment rules and
 * the delete filter are what is being tested, and the routes are thin.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../../src/db/pool.js';
import { createRecord, deleteRecord, restoreRecord } from '../../src/core/entity/recordService.js';
import { editBody, findPending, listPending, queueDeviceSend } from '../../src/integrations/whatsapp/deviceSend.js';
import { adminContext, leadInput } from './fixtures.js';

const MOBILE = `97${String(Date.now()).slice(-8)}`;

let admin: Awaited<ReturnType<typeof adminContext>>;
let userId = '';
let leadId = '';
let sendId = '';

/** Only the rows this test created — the seeded workflow queues its own. */
async function mine(): Promise<{ id: string; body: string }[]> {
  const rows = await listPending(userId, 500);
  return rows.filter((r) => r.recordId === leadId).map((r) => ({ id: r.id, body: r.body }));
}

beforeAll(async () => {
  admin = await adminContext();
  userId = admin.user.id;

  const lead = await createRecord(admin, 'leads', leadInput({
    full_name: 'Queue Test Lead',
    mobile: MOBILE,
  }));
  leadId = lead.id;

  const queued = await queueDeviceSend({
    handle: `+91${MOBILE}`,
    body: 'Hi Queue, are you free on Saturday?',
    recordId: leadId,
    module: 'leads',
    name: 'Queue Test Lead',
    assignedTo: userId,
  });
  sendId = queued.id;
});

describe('the device send queue', () => {
  it('offers a message queued against a live lead', async () => {
    const rows = await mine();
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toContain('are you free on Saturday');
  });

  it('builds a wa.me link carrying the current body', async () => {
    const row = await findPending(sendId, userId);
    expect(row?.link).toContain('https://wa.me/91');
    expect(decodeURIComponent(row!.link)).toContain('are you free on Saturday');
  });

  it('lets the rep reword it before sending, and rebuilds the link', async () => {
    const updated = await editBody(sendId, 'Hi Queue — Saturday 11am at the site?', userId);
    expect(updated?.body).toBe('Hi Queue — Saturday 11am at the site?');
    expect(decodeURIComponent(updated!.link)).toContain('Saturday 11am at the site');

    const [row] = await mine();
    expect(row.body).toBe('Hi Queue — Saturday 11am at the site?');
  });

  it('refuses an empty rewording', async () => {
    await expect(editBody(sendId, '   ', userId)).rejects.toThrow();
  });

  it('drops the message when the lead is deleted', async () => {
    await deleteRecord(admin, 'leads', leadId);
    expect(await mine()).toHaveLength(0);
    // …and it cannot be reached individually either, or the edit and skip
    // endpoints would still act on a record that is gone.
    expect(await findPending(sendId, userId)).toBeNull();
  });

  it('brings it back when the lead is restored from the recycle bin', async () => {
    await restoreRecord(admin, 'leads', leadId);
    const rows = await mine();
    expect(rows).toHaveLength(1);
    // Filtered on read rather than cancelled on delete — which is what makes
    // restoring work at all.
    const row = await db.queryOne<{ status: string }>(
      `SELECT status FROM ipy_device_send WHERE id = $1`, [sendId],
    );
    expect(row?.status).toBe('pending');
  });
});
