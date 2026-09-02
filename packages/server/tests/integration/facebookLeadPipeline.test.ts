/**
 * A Facebook lead ad becomes a lead in the CRM, ready to be greeted.
 *
 * This is the path the team is about to depend on, so it is walked with the
 * payload Meta actually sends rather than a tidy one — Meta's `field_data` is a
 * list of `{name, values[]}` pairs whose names depend on how the form was built,
 * and the phone arrives with a country code already on it.
 *
 * The greeting half is exercised separately because it needs a WhatsApp
 * provider. What is asserted here is that the lead lands complete and reachable,
 * which is the half that has to be right before any provider matters.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { captureLead, normalizeFacebook } from '../../src/integrations/leadsources/capture.js';
import { registry } from '../../src/core/metadata/registry.js';

const made: string[] = [];

beforeAll(async () => { await registry.warmup(); });

afterAll(async () => {
  if (made.length) await db.query(`DELETE FROM ipy_record WHERE id = ANY($1::uuid[])`, [made]);
  await db.query(`DELETE FROM ipy_lead_inbox WHERE external_id LIKE 'fbtest-%'`);
});

/** What Meta hands back from the Graph API for one lead. */
function metaLead(over: { id: string; name: string; phone: string; email?: string }) {
  return {
    id: over.id,
    leadgen_id: over.id,
    created_time: new Date().toISOString(),
    form_id: '1122334455',
    campaign_id: '9988776655',
    campaign_name: 'Greenfields 3BHK — September',
    ad_id: '5544332211',
    field_data: [
      { name: 'full_name', values: [over.name] },
      { name: 'phone_number', values: [over.phone] },
      ...(over.email ? [{ name: 'email', values: [over.email] }] : []),
      { name: 'city', values: ['Faridabad'] },
    ],
  };
}

async function findByMobile(mobile: string) {
  const digits = mobile.replace(/\D/g, '').slice(-10);
  const row = await db.queryOne<{ record_id: string; full_name: string; mobile: string; lead_source: string; contact_type: string }>(
    `SELECT record_id, full_name, mobile, lead_source, contact_type
       FROM ipy_e_leads
      WHERE right(regexp_replace(coalesce(mobile,''), '\\D', '', 'g'), 10) = $1
      ORDER BY record_id DESC LIMIT 1`,
    [digits],
  );
  if (row) made.push(row.record_id);
  return row;
}

describe('a lead from a Facebook lead ad', () => {
  it('becomes a lead with the name and number intact', async () => {
    const payload = metaLead({
      id: 'fbtest-1', name: 'Aftab Siddiqui', phone: '+919811577101', email: 'aftab@example.com',
    });

    await captureLead('facebook', payload, normalizeFacebook(payload), { externalId: payload.id });

    const lead = await findByMobile('9811577101');
    expect(lead, 'the lead never reached the CRM — check ipy_lead_inbox').toBeTruthy();
    expect(lead!.full_name).toBe('Aftab Siddiqui');
    // The number is what the greeting will dial, so it has to survive intact.
    expect(lead!.mobile.replace(/\D/g, '')).toContain('9811577101');
  });

  it('records where it came from, so the spend can be judged', async () => {
    const payload = metaLead({ id: 'fbtest-2', name: 'Priya Nair', phone: '+919811577102' });
    await captureLead('facebook', payload, normalizeFacebook(payload), { externalId: payload.id });

    const lead = await findByMobile('9811577102');
    expect(lead?.lead_source, 'a lead with no source cannot be attributed to an ad').toBeTruthy();
  });

  it('fills the mandatory contact type nobody chose', async () => {
    // The same fault that was discarding every website enquiry would discard
    // every Facebook lead too — it is validation on the shared capture path.
    const payload = metaLead({ id: 'fbtest-3', name: 'Rohit Sharma', phone: '+919811577103' });
    await captureLead('facebook', payload, normalizeFacebook(payload), { externalId: payload.id });

    const lead = await findByMobile('9811577103');
    expect(lead?.contact_type).toBeTruthy();
  });

  it('handles a form that asks for first and last name separately', async () => {
    /*
      Meta forms differ by how they were built. A form using the separate
      name fields is as common as one using `full_name`, and a normaliser that
      only knows one shape drops the name from the other.
    */
    const payload = {
      id: 'fbtest-4',
      field_data: [
        { name: 'first_name', values: ['Kavita'] },
        { name: 'last_name', values: ['Menon'] },
        { name: 'phone_number', values: ['+919811577104'] },
      ],
    };
    await captureLead('facebook', payload, normalizeFacebook(payload), { externalId: 'fbtest-4' });

    const lead = await findByMobile('9811577104');
    expect(lead?.full_name).toContain('Kavita');
  });

  it('leaves a reachable number the greeting can actually use', async () => {
    /*
      The greeting used to read `whatsapp_number`, a field deleted on 11 August,
      so it threw on every captured lead. It reads the mobile now — which is the
      right answer anyway, because almost every Indian buyer uses WhatsApp on the
      number they gave you.
    */
    const payload = metaLead({ id: 'fbtest-5', name: 'Sunita Rao', phone: '+919811577105' });
    await captureLead('facebook', payload, normalizeFacebook(payload), { externalId: payload.id });

    const lead = await findByMobile('9811577105');
    const reachable = await db.queryOne<{ mobile: string | null }>(
      `SELECT to_jsonb(l)->>'mobile' AS mobile FROM ipy_e_leads l WHERE l.record_id = $1`,
      [lead!.record_id],
    );
    expect(reachable?.mobile, 'without a number there is nobody to greet').toBeTruthy();
  });

  it('does not create the same lead twice if Meta delivers it twice', async () => {
    // Meta retries a delivery it thinks failed, and it does not always think
    // correctly. A duplicate lead is a rep ringing somebody twice.
    const payload = metaLead({ id: 'fbtest-6', name: 'Vikram Rao', phone: '+919811577106' });

    await captureLead('facebook', payload, normalizeFacebook(payload), { externalId: payload.id });
    await captureLead('facebook', payload, normalizeFacebook(payload), { externalId: payload.id });

    const rows = await db.query(
      `SELECT record_id FROM ipy_e_leads
        WHERE right(regexp_replace(coalesce(mobile,''), '\\D', '', 'g'), 10) = '9811577106'`,
    );
    for (const r of rows.rows as { record_id: string }[]) made.push(r.record_id);
    expect(rows.rowCount, 'the same lead arrived twice and was created twice').toBe(1);
  });
});
