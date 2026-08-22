/**
 * Every lead that arrives without a human typing it.
 *
 * `captureLead` is the single write path for the website enquiry form, Facebook
 * lead ads, Google Ads, the property portals and email-to-lead — and it had no
 * test at all, which is how it came to be silently rejecting *all* of them.
 *
 * Two independent breakages, both from migration 026 splitting the lead's name
 * and phone into different fields while this file kept writing the old shape:
 *
 *  * it set `first_name`/`last_name` after the module had merged them into one
 *    mandatory `full_name`, so every record failed "Full Name is required";
 *  * it wrote the E.164 number into `mobile`, which now holds national digits
 *    with the country in its own field, so "must be exactly 10 digits".
 *
 * Neither surfaced anywhere a person would look: the public form answers HTTP
 * 200 with its success message whatever happens, so a buyer read "our team will
 * call you shortly" while nothing was created. The failures were recorded in
 * `ipy_lead_inbox` and nowhere else.
 *
 * These assert the record that comes out, not the code that makes it — the same
 * checks would have caught both bugs regardless of how the fix was written.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import {
  captureLead, normalizePortal, type NormalizedLead,
} from '../../src/integrations/leadsources/capture.js';

beforeAll(async () => {
  await registry.warmup();
});

const unique = (): string => Math.random().toString(36).slice(2, 8);
const indianMobile = (): string => `98${Math.floor(10000000 + Math.random() * 89999999)}`;

async function leadRow(recordId: string) {
  return db.queryOne<{
    label: string; full_name: string;
    mobile: string | null; whatsapp_number: string | null;
    lead_source: string | null; sub_source: string | null; status: string;
  }>(
    `SELECT r.label, l.full_name, l.mobile, l.whatsapp_number,
            l.lead_source, l.sub_source, l.status
       FROM ipy_record r JOIN ipy_e_leads l ON l.record_id = r.id
      WHERE r.id = $1`,
    [recordId],
  );
}

function webformLead(over: Partial<NormalizedLead> = {}): NormalizedLead {
  return {
    firstName: `Capture ${unique()}`,
    mobile: indianMobile(),
    source: 'Website',
    ...over,
  };
}

describe('captureLead', () => {
  it('creates a lead from a website enquiry', async () => {
    const normalized = webformLead();
    const result = await captureLead('webform', { raw: true }, normalized);

    expect(result.status).toBe('created');
    expect(result.recordId).toBeTruthy();

    const row = await leadRow(result.recordId!);
    expect(row?.full_name).toBe(normalized.firstName);
    expect(row?.status).toBe('New');
    expect(row?.lead_source).toBe('Website');
  });

  it('joins a first and last name into the one field the module has', async () => {
    const result = await captureLead('webform', {}, webformLead({
      firstName: 'Rohit', lastName: `Sharma ${unique()}`,
    }));
    const row = await leadRow(result.recordId!);
    expect(row?.full_name).toMatch(/^Rohit Sharma /);
  });

  it('never leaves the mandatory name empty, even with nothing to go on', async () => {
    const result = await captureLead('webform', {}, webformLead({ firstName: '', lastName: '' }));
    expect(result.status).toBe('created');
    expect((await leadRow(result.recordId!))?.full_name).toBe('Unknown');
  });

  it('stores an Indian number as ten bare digits', async () => {
    const result = await captureLead('webform', {}, webformLead({ mobile: '+919812345670' }));
    const row = await leadRow(result.recordId!);
    expect(row?.mobile).toBe('9812345670');
    // The dialable form is kept separately — this is what a wa.me link uses.
    expect(row?.whatsapp_number).toBe('+919812345670');
  });

  it('refuses a number that is not an Indian mobile rather than filing it as one', async () => {
    // Migration 064 dropped the country field: every lead is +91. A nine-digit
    // Dubai number must not be quietly stored as though it were Indian, so it
    // fails the ten-digit rule and lands in the inbox where somebody sees it.
    const result = await captureLead('webform', {}, webformLead({ mobile: '+971501234567' }));
    expect(result.status).toBe('failed');
  });

  it('records the failure rather than throwing when a value is rejected', async () => {
    // The inbox is the only place a dropped enquiry is visible, so it has to be
    // written even when nothing else is.
    const result = await captureLead('webform', {}, webformLead({ mobile: 'not-a-number' }));
    expect(['created', 'failed']).toContain(result.status);
    const inbox = await db.queryOne<{ status: string }>(
      `SELECT status FROM ipy_lead_inbox ORDER BY received_at DESC LIMIT 1`,
    );
    expect(inbox?.status).toBeTruthy();
  });
});

describe('portal leads', () => {
  it('uses a sub-source the picklist actually offers', async () => {
    // 'Portal' was not one of them, so every 99acres, MagicBricks and Housing
    // enquiry was refused with "Sub Source must be one of: …".
    const normalized = normalizePortal('99acres', {
      name: `Portal Buyer ${unique()}`,
      phone: indianMobile(),
      project: 'Skyline Aurum',
    });
    const result = await captureLead('99acres', {}, normalized);

    expect(result.status).toBe('created');
    const row = await leadRow(result.recordId!);
    expect(row?.lead_source).toBe('99acres');

    const allowed = await db.query<{ value: string }>(
      `SELECT plv.value FROM ipy_picklist_value plv
         JOIN ipy_picklist pl ON pl.id = plv.picklist_id
        WHERE pl.name = 'lead_sub_source'`,
    );
    expect(allowed.rows.map((r) => r.value)).toContain(row?.sub_source);
  });

  it('keeps which portal it was, since that is what lead_source is for', async () => {
    const result = await captureLead('MagicBricks', {}, normalizePortal('MagicBricks', {
      name: `MB Buyer ${unique()}`, phone: indianMobile(),
    }));
    expect((await leadRow(result.recordId!))?.lead_source).toBe('MagicBricks');
  });
});
