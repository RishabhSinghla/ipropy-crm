/**
 * An enquiry from the website becomes a lead somebody can call.
 *
 * It did not. The form answered `"Thanks — our team will call you shortly."`
 * and created nothing. Every single website enquiry was thrown away, and the
 * only trace was a row in `ipy_lead_inbox` marked failed — in a table nobody
 * opens — with the reason "Contact Type is required".
 *
 * Two separate faults, either of which was enough on its own:
 *
 *  * **`contact_type` is mandatory and no option was marked default.** So
 *    nothing that creates a lead without explicitly choosing one could succeed,
 *    which is every automated source there is: the website form, Facebook,
 *    Google, the portals, inbound email.
 *  * **The web form normaliser never read `full_name`.** It looked for
 *    `first_name`, `firstName` and `name`. `full_name` is the name of the CRM's
 *    own field, so a form built to match the CRM sent exactly the one key it did
 *    not accept — and the `?? 'Website'` fallback stepped over the empty string,
 *    because `''` is not nullish.
 *
 * This is the most important path in the product and the failure was completely
 * silent from outside. The response even said the right thing. So this test
 * asserts the row exists, not that the request succeeded.
 *
 * CLAUDE.md already records an earlier version of this exact failure. It has now
 * happened twice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';

let app: Express;
let formKey: string;
const made: string[] = [];

beforeAll(async () => {
  await registry.warmup();
  app = createApp();

  const form = await db.queryOne<{ public_key: string }>(
    `SELECT public_key FROM ipy_webform WHERE is_active LIMIT 1`,
  );
  if (!form) throw new Error('no active web form to test against');
  formKey = form.public_key;
});

afterAll(async () => {
  if (made.length) await db.query(`DELETE FROM ipy_record WHERE id = ANY($1::uuid[])`, [made]);
  await db.query(`DELETE FROM ipy_lead_inbox WHERE normalized::text LIKE '%enquiry-test%'`);
});

/**
 * A unique number per submission.
 *
 * Random numbers collided between cases in the first version of this file, and
 * capture deduplicates on the phone number — so the second lead merged into the
 * first and the test read that as "no lead was created". The code was fine; the
 * test was wrong, which is its own kind of failure worth not repeating.
 */
let nextMobile = 9811590000;
const freshMobile = (): string => String(nextMobile++);

async function submit(body: Record<string, unknown>) {
  return request(app).post(`/api/webhooks/forms/${formKey}`).send(body);
}

/**
 * Poll rather than sleep.
 *
 * The route answers before capture finishes — deliberately, so a slow scoring
 * pass never delays the visitor. A fixed wait is therefore a race, and the first
 * version of this file lost it under load and reported bugs that were not there.
 */
async function findLead(mobile: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await db.queryOne<{ record_id: string; full_name: string; contact_type: string | null }>(
      `SELECT record_id, full_name, contact_type FROM ipy_e_leads
        WHERE right(regexp_replace(coalesce(mobile,''), '\\D', '', 'g'), 10) = right($1, 10)
        ORDER BY record_id DESC LIMIT 1`,
      [mobile],
    );
    if (row) { made.push(row.record_id); return row; }
    if (Date.now() > deadline) return null;
    await new Promise((r) => { setTimeout(r, 400); });
  }
}

describe('an enquiry from the website', () => {
  it('creates a lead when the form sends full_name', async () => {
    /*
      The exact shape that was being discarded. `full_name` is what the CRM's own
      field is called, so it is the obvious key for anybody wiring up a form —
      and it was the one key the normaliser did not read.
    */
    const mobile = freshMobile();
    const res = await submit({
      full_name: 'Aftab Siddiqui',
      mobile,
      email: 'enquiry-test-a@example.com',
      message: '3 BHK builder floor in Greenfields, budget 1.4 Cr',
    });

    expect(res.status).toBe(200);
    // The response said the right thing while creating nothing, so the response
    // is not the assertion. The row is.
    expect(res.body.ok, 'the form reported success while discarding the lead').toBe(true);

    const lead = await findLead(mobile);
    expect(lead, 'no lead was created — check ipy_lead_inbox for the reason').toBeTruthy();
    expect(lead!.full_name).toBe('Aftab Siddiqui');
  });

  it('fills in the contact type nobody supplied', async () => {
    // Mandatory, and not one of its nine options was marked default, so every
    // automated source failed validation on it.
    const mobile = freshMobile();
    await submit({ full_name: 'Priya Nair', mobile, email: 'enquiry-test-b@example.com' });

    const lead = await findLead(mobile);
    expect(lead?.contact_type, 'a mandatory field with no default blocks every automated lead')
      .toBeTruthy();
  });

  it.each([
    ['full_name', { full_name: 'Rohit Sharma' }],
    ['name', { name: 'Rohit Sharma' }],
    ['first_name and last_name', { first_name: 'Rohit', last_name: 'Sharma' }],
    ['firstName and lastName', { firstName: 'Rohit', lastName: 'Sharma' }],
  ])('accepts a name sent as %s', async (_shape, nameFields) => {
    // Every one of these is a reasonable thing for somebody wiring up a form to
    // send, and the CRM should not care which they picked.
    /*
      A unique email per case as well as a unique number. Capture deduplicates on
      both, so four submissions sharing one address merged into the first record
      and the later cases read as "no lead was created" — the second time this
      file reported a bug that was the test's own doing.
    */
    const mobile = freshMobile();
    await submit({ ...nameFields, mobile, email: `enquiry-test-${mobile}@example.com` });

    const lead = await findLead(mobile);
    expect(lead, `a form sending ${_shape} produced no lead`).toBeTruthy();
    expect(lead!.full_name.toLowerCase()).toContain('rohit');
  });

  it('keeps a lead that has a number but no name at all', async () => {
    /*
      A nameless enquiry with a real phone number is still worth calling, and
      rejecting it loses the number too. It should land with a placeholder name
      rather than being discarded.
    */
    const mobile = freshMobile();
    await submit({ mobile, message: 'call me' });

    const lead = await findLead(mobile);
    expect(lead, 'an anonymous enquiry with a real number must still be captured').toBeTruthy();
  });

  it('leaves nothing in the failed inbox for a valid enquiry', async () => {
    // The inbox is where these went to die unseen. A valid submission must not
    // add to it.
    const before = await db.queryOne<{ n: string }>(
      `SELECT count(*) AS n FROM ipy_lead_inbox WHERE status = 'failed'`,
    );

    const mobile = freshMobile();
    await submit({ full_name: 'Kavita Menon', mobile, email: 'enquiry-test-d@example.com' });
    await findLead(mobile);

    const after = await db.queryOne<{ n: string }>(
      `SELECT count(*) AS n FROM ipy_lead_inbox WHERE status = 'failed'`,
    );
    expect(Number(after?.n), 'a valid enquiry was rejected into the inbox')
      .toBe(Number(before?.n));
  });
});
