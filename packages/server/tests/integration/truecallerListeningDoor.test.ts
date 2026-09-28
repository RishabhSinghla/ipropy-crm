/**
 * The Truecaller door listens and does nothing else.
 *
 * Truecaller's mobile-web documentation has not been updated in six years and
 * is unreachable from this container, so the shape of a delivery is unknown.
 * The door exists to find that shape out from real traffic rather than from a
 * guess — the WhatsMarketing adapter was written from a sensible guess and was
 * wrong in four separate ways, one of which recorded refused messages as sent.
 *
 * Two promises, and the second is the one that makes an unauthenticated public
 * endpoint acceptable at all:
 *
 *  * what arrived is stored where somebody can read it;
 *  * **nothing is created** — no lead, no contact, nothing on a rep's screen.
 *
 * The day this door starts creating records it needs a signature check first,
 * and this file is where that has to be proved.
 */
import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';

let app: Express;

/** Its own marker, so nothing here depends on what is already in the database. */
const marker = `tc-${Math.random().toString(36).slice(2, 10)}`;

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  await db.query(`DELETE FROM ipy_lead_inbox WHERE source = 'truecaller'`);
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_lead_inbox WHERE source = 'truecaller'`);
});

type Delivery = { status: string; error: string | null; raw_payload: Record<string, unknown> };

async function storedDeliveries(): Promise<Delivery[]> {
  const { rows } = await db.query<Delivery>(
    `SELECT status, error, raw_payload FROM ipy_lead_inbox
      WHERE source = 'truecaller' ORDER BY received_at DESC, id DESC`,
  );
  return rows;
}

/**
 * The door answers 200 *before* it writes, on purpose — a provider retries
 * anything it does not hear a prompt 200 for. So the response arriving is not
 * the row arriving, and a test that reads straight after the request is
 * racing it. This waits for the delivery rather than assuming it is there.
 */
async function waitForDelivery(matches: (d: Delivery) => boolean): Promise<Delivery> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const found = (await storedDeliveries()).find(matches);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('the delivery was never recorded');
}

describe('the Truecaller listening door', () => {
  it('answers 200 and stores exactly what arrived', async () => {
    await request(app)
      .post('/api/webhooks/truecaller')
      .send({ requestId: marker, status: 'verified', phoneNumber: '919812345678' })
      .expect(200);

    const stored = await waitForDelivery(
      (d) => (d.raw_payload.body as Record<string, unknown> | null)?.requestId === marker,
    );

    const body = stored.raw_payload.body as Record<string, unknown>;
    expect(body.phoneNumber).toBe('919812345678');
    expect(stored.raw_payload.method).toBe('POST');
  });

  it('creates no lead — the whole point of it being inert', async () => {
    const before = await db.queryOne<{ n: string }>(`SELECT count(*)::text AS n FROM ipy_e_leads`);

    await request(app)
      .post('/api/webhooks/truecaller')
      .send({ requestId: `${marker}-2`, name: 'Someone Who Must Not Be Created', phoneNumber: '919800000001' })
      .expect(200);

    const stored = await waitForDelivery(
      (d) => (d.raw_payload.body as Record<string, unknown> | null)?.requestId === `${marker}-2`,
    );

    const after = await db.queryOne<{ n: string }>(`SELECT count(*)::text AS n FROM ipy_e_leads`);
    expect(after?.n).toBe(before?.n);

    // And it says so on the row, rather than looking like a capture that failed.
    expect(stored.status).toBe('pending');
    expect(stored.error).toMatch(/no lead was created/i);
  });

  it('keeps a signature header and drops a credential one', async () => {
    await request(app)
      .post('/api/webhooks/truecaller')
      .set('x-truecaller-signature', 'a-signature-we-will-need-later')
      .set('authorization', 'Bearer this-must-not-be-stored')
      .send({ requestId: `${marker}-3` })
      .expect(200);

    const stored = await waitForDelivery(
      (d) => (d.raw_payload.body as Record<string, unknown> | null)?.requestId === `${marker}-3`,
    );

    const headers = stored.raw_payload.headers as Record<string, string>;
    expect(headers['x-truecaller-signature']).toBe('a-signature-we-will-need-later');
    expect(headers.authorization).toBeUndefined();
  });

  it('takes a GET as well, since an unknown provider may verify with one', async () => {
    await request(app).get('/api/webhooks/truecaller').query({ challenge: marker }).expect(200);

    const stored = await waitForDelivery(
      (d) => (d.raw_payload.query as Record<string, string> | null)?.challenge === marker,
    );
    expect(stored.raw_payload.method).toBe('GET');
  });
});
