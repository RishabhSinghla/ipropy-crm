/**
 * Sending one property to one person.
 *
 * A share link is an unauthenticated door into a record, so most of what is
 * asserted here is about the door being exactly as wide as intended: this
 * property and no other, these photos and no others, off the moment it is
 * revoked, and never carrying a field the CRM keeps to itself.
 *
 * The one thing it deliberately does *not* check is publication status. That
 * gate is right for the website and wrong for sending — the property somebody
 * most wants to send is the floor they shot this morning, which is a draft.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { recordService, type ServiceContext } from '../../src/core/entity/recordService.js';
import { mintToken } from '../../src/core/sharing/shareLinks.js';
import { adminContext, leadInput, propertyInput, SEEDED } from './fixtures.js';

let app: Express;
let token: string;
let ctx: ServiceContext;

async function login(email: string): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'Admin@123' });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status}`);
  return res.body.token as string;
}

/** A property with a photo on it, in whatever state the test needs. */
async function propertyWithPhoto(name: string, values: Record<string, unknown> = {}): Promise<{
  id: string; attachmentId: string;
}> {
  const record = await recordService.createRecord(ctx, 'properties', propertyInput({ full_name: name, ...values }));
  const att = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_attachment (record_id, file_name, mime_type, size, storage_key)
     VALUES ($1,'IMG_1.jpg','image/jpeg',100,$2) RETURNING id`,
    [record.id, `itest/share-${record.id}.jpg`],
  );
  return { id: record.id, attachmentId: att!.id };
}

const share = (recordId: string, body: Record<string, unknown> = {}) =>
  request(app).post(`/api/records/properties/${recordId}/share-links`)
    .set('Authorization', `Bearer ${token}`).send(body);

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  ctx = await adminContext();
  const admin = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`,
  );
  token = await login(admin!.email);
});

describe('minting a token', () => {
  it('is unguessable and never repeats', () => {
    // The token is the only thing between a link and the open internet.
    const tokens = new Set(Array.from({ length: 500 }, () => mintToken()));
    expect(tokens.size).toBe(500);
    expect([...tokens][0]!.length).toBeGreaterThanOrEqual(22);
    // base64url — safe to paste into a WhatsApp message without escaping.
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('creating a link', () => {
  it('needs authentication', async () => {
    const { id } = await propertyWithPhoto('Share Auth Floor');
    await request(app).post(`/api/records/properties/${id}/share-links`).send({}).expect(401);
  });

  it('returns a token and records who it is for', async () => {
    const { id } = await propertyWithPhoto('Share Basic Floor');
    const res = await share(id, { label: 'Rajesh' }).expect(201);
    expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(res.body.label).toBe('Rajesh');
    expect(res.body.viewCount).toBe(0);
    expect(res.body.expiresAt).toBeNull();
  });

  it('makes a fresh link every time', async () => {
    // Reusing one across two buyers would make the view count meaningless and
    // revoking for one would revoke for both.
    const { id } = await propertyWithPhoto('Share Twice Floor');
    const a = await share(id, { label: 'Rajesh' }).expect(201);
    const b = await share(id, { label: 'Rajesh' }).expect(201);
    expect(a.body.token).not.toBe(b.body.token);
  });

  it('refuses a record the caller cannot see', async () => {
    // Tested against `leads`, not `properties`, and the reason matters: the
    // seed gives properties `public_read` org-wide because inventory is meant
    // to be visible to the whole office, so there is no property an ordinary
    // user is refused. Leads are `private`, which is where the guard can
    // actually be observed. The route is module-generic, so this is the same
    // check a property would get if someone tightened that sharing rule.
    //
    // Owned by a *peer* executive, which is what "cannot see" now means. It
    // used to be the telecaller, and that stopped being invisible when
    // Telecaller moved underneath Sales Executive in the reporting line —
    // a record below you in the hierarchy is one you are meant to see.
    const lead = await recordService.createRecord(ctx, 'leads', leadInput());
    await db.query(
      `UPDATE ipy_record SET owner_id = (SELECT id FROM ipy_user WHERE email = $1) WHERE id = $2`,
      [SEEDED.executiveA, lead.id],
    );

    const other = await login(SEEDED.executiveB);
    const res = await request(app).post(`/api/records/leads/${lead.id}/share-links`)
      .set('Authorization', `Bearer ${other}`).send({});
    expect([403, 404]).toContain(res.status);
  });
});

describe('opening a link', () => {
  it('shows a property that is nowhere near ready for the website', async () => {
    // The entire point. The public catalogue requires status 'Available' and
    // publish_to_web; a floor shot this morning is a draft with forty photos on
    // it, and it is exactly the one somebody wants to send.
    const { id } = await propertyWithPhoto('Draft Floor', { status: 'Sold', property_type: 'Builder Floor' });
    const { body } = await share(id).expect(201);

    // Confirm the catalogue genuinely will not show it…
    await request(app).get(`/api/public/properties/${id}`).expect(404);
    // …and the link does.
    const res = await request(app).get(`/api/public/share/${body.token}`).expect(200);
    expect(res.body.property.property_type).toBe('Builder Floor');
    // Exact identity is private by default even though the link itself works.
    expect(res.body.property).not.toHaveProperty('full_name');
  });

  it('needs no authentication', async () => {
    const { id } = await propertyWithPhoto('Open Floor');
    const { body } = await share(id).expect(201);
    // No Authorization header anywhere in this request — a buyer will open it
    // on a phone, and anything requiring a login would simply not be used.
    await request(app).get(`/api/public/share/${body.token}`).expect(200);
  });

  it('lists the record\'s own photos, not the gallery field', async () => {
    // A captured property has an empty `gallery` and forty attachments.
    const { id, attachmentId } = await propertyWithPhoto('Photo Floor');
    const { body } = await share(id).expect(201);

    const res = await request(app).get(`/api/public/share/${body.token}`).expect(200);
    expect(res.body.photos).toHaveLength(1);
    expect(res.body.photos[0].id).toBe(attachmentId);
    expect(res.body.photos[0].url).toBe(`/api/public/share/${body.token}/media/${attachmentId}`);
    expect(JSON.stringify(res.body)).not.toContain('IMG_1.jpg');
  });

  it('never tells the visitor who the link was for', async () => {
    // The label is the sender's private note. A buyer opening a link should not
    // be shown what the dealer wrote about them.
    const { id } = await propertyWithPhoto('Labelled Floor');
    const { body } = await share(id, { label: 'Rajesh — lowballing, push to 1.6' }).expect(201);

    const res = await request(app).get(`/api/public/share/${body.token}`).expect(200);
    expect(JSON.stringify(res.body)).not.toContain('Rajesh');
    expect(JSON.stringify(res.body)).not.toContain('lowballing');
  });

  it('carries none of the fields the CRM keeps to itself', async () => {
    const { id } = await propertyWithPhoto('Guarded Floor');
    const { body } = await share(id).expect(201);
    const res = await request(app).get(`/api/public/share/${body.token}`).expect(200);

    // The payload is an explicit column whitelist, so this is a guard against
    // somebody widening it later rather than a claim about today's schema.
    for (const leak of [
      'full_name', 'project_name', 'tower', 'wing', 'unit_number', 'city', 'locality',
      'owner_id', 'owner_name', 'owner_phone', 'custom_fields', 'commission',
    ]) {
      expect(Object.keys(res.body.property)).not.toContain(leak);
    }
  });

  it('applies the admin field and photo choices on the server', async () => {
    const original = await db.queryOne<{ value: unknown }>(
      `SELECT value FROM ipy_setting WHERE key = 'sharing.property_link'`,
    );
    try {
      const config = await request(app).put('/api/admin/sharing/property-link')
        .set('Authorization', `Bearer ${token}`)
        .send({ visibleFields: ['full_name', 'bedrooms'], showPhotos: false })
        .expect(200);
      expect(config.body.fields.find((field: { name: string }) => field.name === 'full_name').visible).toBe(true);
      expect(config.body.fields.some((field: { name: string }) => field.name === 'owner_contact_id')).toBe(false);

      const { id, attachmentId } = await propertyWithPhoto('Admin Controlled Floor', {
        bedrooms: 4, unit_number: 'SECRET-1204', locality: 'Whitefield',
      });
      const { body } = await share(id).expect(201);
      const publicView = await request(app).get(`/api/public/share/${body.token}`).expect(200);

      expect(publicView.body.property).toEqual({ full_name: 'Admin Controlled Floor', bedrooms: 4 });
      expect(publicView.body.fields.map((field: { name: string }) => field.name)).toEqual(['full_name', 'bedrooms']);
      expect(publicView.body.photos).toEqual([]);
      expect(JSON.stringify(publicView.body)).not.toContain('SECRET-1204');
      expect(JSON.stringify(publicView.body)).not.toContain('Whitefield');
      await request(app).get(`/api/public/share/${body.token}/media/${attachmentId}`).expect(404);
    } finally {
      // Restored by putting the row back the way it was found — including not
      // at all. Since migration 132 the default lives in code and the row only
      // exists once an admin has saved on the screen, so an UPDATE here
      // matched nothing and the row this test wrote was left standing for
      // every test after it.
      if (original) {
        await db.query(
          `UPDATE ipy_setting SET value = $1::jsonb WHERE key = 'sharing.property_link'`,
          [JSON.stringify(original.value)],
        );
      } else {
        await db.query(`DELETE FROM ipy_setting WHERE key = 'sharing.property_link'`);
      }
    }
  });

  /**
   * The bug this pins cost every share link its price.
   *
   * The buyer-facing field list was twenty-six names written into a row by
   * migration 042, and the page read `total_price` directly. Production
   * deleted both that column and twenty others and created `asking_price` in
   * their place, so a link showed five details, no price and no size — and not
   * even "Price on request", because the price line only renders when there is
   * a number. Nothing failed; the link just looked empty.
   *
   * So this asserts the two halves that were wrong: the default reaches a
   * field nobody could have listed in advance, and the price comes back
   * resolved rather than read by name.
   */
  it('shows the price from the field Budget is mapped to, not one read by name', async () => {
    // Priced through `base_price`, which is what Budget resolves to on a
    // seeded database. The old page read `total_price` and would find nothing
    // here — the same way it found nothing on production, where the field is
    // `asking_price` and `total_price` has been deleted outright.
    const { id } = await propertyWithPhoto('Priced Floor', { base_price: 9900000 });
    const { body } = await share(id).expect(201);
    const view = await request(app).get(`/api/public/share/${body.token}`).expect(200);

    expect(view.body.priceShared).toBe(true);
    expect(view.body.price).toBe(9900000);
    // Shown once, in the header — not again in the facts list underneath.
    expect(view.body.fields.some((f: { name: string }) => f.name === 'asking_price')).toBe(false);
    // And the promise the default is making: identity and exact address stay
    // off, and so does the state of the sale.
    const names = view.body.fields.map((f: { name: string }) => f.name);
    for (const withheld of ['full_name', 'unit_number', 'locality', 'lost_reason', 'next_follow_up']) {
      expect(names).not.toContain(withheld);
    }
  });

  it('counts the visit', async () => {
    const { id } = await propertyWithPhoto('Counted Floor');
    const { body } = await share(id).expect(201);

    await request(app).get(`/api/public/share/${body.token}`).expect(200);
    await request(app).get(`/api/public/share/${body.token}`).expect(200);

    // Counted asynchronously so a failed counter cannot block the response,
    // which means the count can lag the 200s on a loaded runner. Poll rather
    // than sleeping a fixed interval: the assertion is about whether both
    // views were recorded, not about how fast, and a fixed 120ms occasionally
    // raced the fire-and-forget UPDATE (view_count 1 of 2).
    let row: { view_count: number; last_viewed_at: Date | null } | null = null;
    for (let attempt = 0; attempt < 50; attempt++) {
      row = await db.queryOne<{ view_count: number; last_viewed_at: Date | null }>(
        `SELECT view_count, last_viewed_at FROM ipy_share_link WHERE id = $1`, [body.id],
      );
      if (row?.view_count === 2) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(row!.view_count).toBe(2);
    expect(row!.last_viewed_at).not.toBeNull();
  });
});

describe('closing a link', () => {
  it('stops working the moment it is revoked', async () => {
    const { id } = await propertyWithPhoto('Revoked Floor');
    const { body } = await share(id).expect(201);
    await request(app).get(`/api/public/share/${body.token}`).expect(200);

    await request(app).delete(`/api/records/properties/${id}/share-links/${body.id}`)
      .set('Authorization', `Bearer ${token}`).expect(204);

    await request(app).get(`/api/public/share/${body.token}`).expect(404);
  });

  it('keeps the history after revoking', async () => {
    // "Rajesh opened this eleven times before I turned it off" is worth keeping.
    const { id } = await propertyWithPhoto('History Floor');
    const { body } = await share(id, { label: 'Rajesh' }).expect(201);
    await request(app).delete(`/api/records/properties/${id}/share-links/${body.id}`)
      .set('Authorization', `Bearer ${token}`).expect(204);

    const res = await request(app).get(`/api/records/properties/${id}/share-links`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].label).toBe('Rajesh');
    expect(res.body[0].revokedAt).not.toBeNull();
  });

  it('expires on its own when asked to', async () => {
    const { id } = await propertyWithPhoto('Expiring Floor');
    const { body } = await share(id, { expiresInDays: 7 }).expect(201);
    await request(app).get(`/api/public/share/${body.token}`).expect(200);

    await db.query(`UPDATE ipy_share_link SET expires_at = now() - interval '1 minute' WHERE id = $1`, [body.id]);
    await request(app).get(`/api/public/share/${body.token}`).expect(404);
  });

  it('dies with the record', async () => {
    const { id } = await propertyWithPhoto('Deleted Floor');
    const { body } = await share(id).expect(201);
    await db.query(`UPDATE ipy_record SET is_deleted = true WHERE id = $1`, [id]);
    await request(app).get(`/api/public/share/${body.token}`).expect(404);
  });

  it('answers a made-up token the same way as a revoked one', async () => {
    // Distinguishing them would tell somebody probing for links that they had
    // found a real one.
    const { id } = await propertyWithPhoto('Probe Floor');
    const { body } = await share(id).expect(201);
    await request(app).delete(`/api/records/properties/${id}/share-links/${body.id}`)
      .set('Authorization', `Bearer ${token}`).expect(204);

    const revoked = await request(app).get(`/api/public/share/${body.token}`).expect(404);
    const invented = await request(app).get(`/api/public/share/${mintToken()}`).expect(404);
    expect(revoked.body.message).toBe(invented.body.message);
  });
});

describe('the images behind a link', () => {
  it('serves a photo belonging to the shared property', async () => {
    const { id, attachmentId } = await propertyWithPhoto('Image Floor');
    const { body } = await share(id).expect(201);
    // The bytes are missing from storage in this suite, which is the point of
    // asserting on the status rather than the body: 404-from-storage is a
    // different failure from 404-not-authorised, and the route reached it.
    // Reaching a storage-missing 404 is the proof: an unauthorised attachment
    // is rejected before storage is ever consulted, so getting this far means
    // the token authorised it.
    const res = await request(app).get(`/api/public/share/${body.token}/media/${attachmentId}`);
    expect(res.status).toBe(404);
  });

  it('refuses an image from a property the link is not for', async () => {
    // The obvious attack: hold one valid link, swap the attachment id.
    const shared = await propertyWithPhoto('Shared Floor');
    const other = await propertyWithPhoto('Other Floor');
    const { body } = await share(shared.id).expect(201);

    await request(app)
      .get(`/api/public/share/${body.token}/media/${other.attachmentId}`)
      .expect(404);
  });

  it('refuses images once the link is revoked', async () => {
    const { id, attachmentId } = await propertyWithPhoto('Revoked Image Floor');
    const { body } = await share(id).expect(201);
    await request(app).delete(`/api/records/properties/${id}/share-links/${body.id}`)
      .set('Authorization', `Bearer ${token}`).expect(204);

    await request(app).get(`/api/public/share/${body.token}/media/${attachmentId}`).expect(404);
  });
});
