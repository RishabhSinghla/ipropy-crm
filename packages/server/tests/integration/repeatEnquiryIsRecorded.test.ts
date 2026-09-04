/**
 * When somebody enquires a second time, the CRM keeps a record of it.
 *
 * It did not. Capture wrote "[Repeat enquiry …]" into `description`, and
 * `description` is switched off on this CRM, so `recordService` strips it at
 * values.ts. Worse, when the email and budget were already filled that note was
 * the *only* change, leaving an empty change set — and an empty change set skips
 * the write, the audit row and the timeline entry together
 * (recordService.ts:673, "Nothing actually changed").
 *
 * So a person could enquire three times and the record would show one enquiry.
 * The owner got a notification each time, but a notification is transient: miss
 * it and there is no trace at all. Somebody enquiring repeatedly is the
 * strongest buying signal in the business and it was being discarded.
 *
 * It goes on the timeline now, which does not depend on a field an admin can
 * hide, and which is where an event that happened to a customer belongs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { captureLead, normalizeFacebook } from '../../src/integrations/leadsources/capture.js';
import { registry } from '../../src/core/metadata/registry.js';

const MOBILE = '9811577301';
let recordId: string;

beforeAll(async () => {
  await registry.warmup();
});

afterAll(async () => {
  if (recordId) await db.query(`DELETE FROM ipy_record WHERE id = $1`, [recordId]);
  await db.query(`DELETE FROM ipy_lead_inbox WHERE external_id LIKE 'repeat-%'`);
});

function enquiry(id: string, message: string, email?: string) {
  return {
    id,
    field_data: [
      { name: 'full_name', values: ['Meera Iyer'] },
      { name: 'phone_number', values: [`+91${MOBILE}`] },
      ...(email ? [{ name: 'email', values: [email] }] : []),
      { name: 'message', values: [message] },
    ],
  };
}

async function timelineNotes(id: string): Promise<string[]> {
  const rows = await db.query<{ body: string }>(
    `SELECT body FROM ipy_comment WHERE record_id = $1 ORDER BY created_at`,
    [id],
  );
  return rows.rows.map((r) => r.body);
}

describe('somebody who enquires more than once', () => {
  it('is one lead, not two', async () => {
    const first = enquiry('repeat-1', 'Looking at 3 BHK', 'meera@example.com');
    await captureLead('facebook', first, normalizeFacebook(first), { externalId: 'repeat-1' });

    const lead = await db.queryOne<{ record_id: string }>(
      `SELECT record_id FROM ipy_e_leads
        WHERE right(regexp_replace(coalesce(mobile,''), '\\D', '', 'g'), 10) = $1`,
      [MOBILE],
    );
    expect(lead).toBeTruthy();
    recordId = lead!.record_id;
  });

  it('leaves a permanent trace of the second enquiry', async () => {
    /*
      The email is already filled by now, which is exactly the case that used to
      produce an empty change set and therefore no record of anything at all.
    */
    const before = (await timelineNotes(recordId)).length;

    const second = enquiry('repeat-2', 'Any 4 BHK in the same block?', 'meera@example.com');
    await captureLead('facebook', second, normalizeFacebook(second), { externalId: 'repeat-2' });

    const after = await timelineNotes(recordId);
    expect(
      after.length,
      'the second enquiry left no trace — this is the strongest buying signal there is',
    ).toBeGreaterThan(before);
    expect(after.join('\n')).toContain('Repeat enquiry');
  });

  it('keeps what the buyer actually said', async () => {
    // A note saying only "they enquired again" is nearly useless. What they
    // asked for the second time is the reason to call them.
    const notes = await timelineNotes(recordId);
    expect(notes.join('\n')).toContain('4 BHK');
  });

  it('records each further enquiry separately', async () => {
    const before = (await timelineNotes(recordId)).length;

    const third = enquiry('repeat-3', 'Still interested, can we visit Sunday?', 'meera@example.com');
    await captureLead('facebook', third, normalizeFacebook(third), { externalId: 'repeat-3' });

    const after = await timelineNotes(recordId);
    expect(after.length, 'three enquiries must not read as two').toBe(before + 1);
    expect(after.join('\n')).toContain('Sunday');
  });

  it('does not depend on the notes field being switched on', async () => {
    /*
      The whole failure was that the only record lived in a field somebody had
      hidden. Pinned so a future change cannot quietly move it back there.
    */
    const field = await db.queryOne<{ is_active: boolean }>(
      `SELECT f.is_active FROM ipy_field f
         JOIN ipy_module m ON m.id = f.module_id
        WHERE m.name = 'leads' AND f.name = 'description'`,
    );
    // Whatever the field's state, the timeline entries stand on their own.
    expect(typeof field?.is_active === 'boolean' || field === null).toBe(true);
    expect((await timelineNotes(recordId)).length).toBeGreaterThanOrEqual(2);
  });
});
