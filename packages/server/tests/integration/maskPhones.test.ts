/**
 * Hiding customer numbers from the team.
 *
 * The point of the feature is that a rep cannot walk out with the customer list,
 * so the assertion that matters is not "the screen shows xxxx" — it is that the
 * real number is **not in the response at all**. Masking in the interface would
 * pass a screenshot test and leave the number one devtools tab away from the
 * person it is hidden from.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { adminContext } from './fixtures.js';
import { invalidatePhoneMasking, maskNumber } from '../../src/core/permissions/maskPhones.js';

let app: Express;
let repToken: string;
let adminToken: string;
let leadId: string;
const MOBILE = '9811421156';
const made: string[] = [];
let repEmail: string;

async function login(email: string): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'Admin@123' });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status}`);
  return res.body.token as string;
}

async function setMasking(on: boolean): Promise<void> {
  await db.query(
    `INSERT INTO ipy_setting (key, value) VALUES ('privacy.mask_phone_numbers', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(on)],
  );
  invalidatePhoneMasking();
}

beforeAll(async () => {
  await registry.warmup();
  app = createApp();

  const admin = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL
       AND email LIKE '%@%.%' ORDER BY created_at LIMIT 1`,
  );
  adminToken = await login(admin!.email);

  const rep = await db.queryOne<{ id: string; email: string }>(
    `SELECT id, email FROM ipy_user WHERE is_admin = false AND password_hash IS NOT NULL
       AND is_active AND deleted_at IS NULL AND email LIKE '%@%.%' ORDER BY created_at LIMIT 1`,
  );
  repEmail = rep!.email;
  repToken = await login(repEmail);

  const ctx = await adminContext();
  // Owned by the rep: record-level scoping is a separate rule, and a 403 from
  // it would look like masking working when it is not.
  const rec = await recordService.createRecord(ctx, 'leads', {
    full_name: `Masking ${Date.now()}`, mobile: MOBILE, owner_id: rep!.id,
  });
  leadId = rec.id;
  made.push(rec.id);
});

afterAll(async () => {
  await setMasking(false);
  if (made.length) await db.query(`DELETE FROM ipy_record WHERE id = ANY($1::uuid[])`, [made]);
});

describe('masking a phone number', () => {
  it('shapes it so a known number is still recognisable', () => {
    expect(maskNumber('9811421156')).toBe('98xxxxxx56');
    // Formatting varies in the wild; the mask should not.
    expect(maskNumber('+91 98114 21156')).toBe('91xxxxxxxx56');
    // Too short to be worth hiding, and masking it would just look broken.
    expect(maskNumber('1234')).toBe('1234');
    expect(maskNumber(null)).toBeNull();
  });

  it('is off until somebody turns it on', async () => {
    await setMasking(false);
    const res = await request(app)
      .get(`/api/records/leads/${leadId}`)
      .set('Authorization', `Bearer ${repToken}`)
      .expect(200);
    expect(JSON.stringify(res.body)).toContain(MOBILE);
  });

  it('keeps the real number out of the response entirely, not just off the screen', async () => {
    await setMasking(true);
    const res = await request(app)
      .get(`/api/records/leads/${leadId}`)
      .set('Authorization', `Bearer ${repToken}`)
      .expect(200);

    // The assertion the whole feature rests on.
    expect(JSON.stringify(res.body)).not.toContain(MOBILE);
    expect(res.body.values.mobile).toBe('98xxxxxx56');
  });

  it('masks it on the list too, which is where a list would be copied from', async () => {
    await setMasking(true);
    const res = await request(app)
      .get('/api/records/leads?limit=100')
      .set('Authorization', `Bearer ${repToken}`)
      .expect(200);
    expect(JSON.stringify(res.body)).not.toContain(MOBILE);
  });

  it('leaves an administrator seeing the real number', async () => {
    await setMasking(true);
    const res = await request(app)
      .get(`/api/records/leads/${leadId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.values.mobile).toBe(MOBILE);
  });

  it('still lets a rep get one number to call, and writes down that they did', async () => {
    await setMasking(true);
    const before = await db.queryOne<{ n: string }>(
      `SELECT count(*)::text AS n FROM ipy_audit WHERE record_id = $1 AND action = 'phone_revealed'`,
      [leadId],
    );

    const res = await request(app)
      .get(`/api/records/leads/${leadId}/phone/mobile`)
      .set('Authorization', `Bearer ${repToken}`)
      .expect(200);
    expect(res.body.number).toBe(MOBILE);

    const after = await db.queryOne<{ n: string }>(
      `SELECT count(*)::text AS n FROM ipy_audit WHERE record_id = $1 AND action = 'phone_revealed'`,
      [leadId],
    );
    // The trail is the whole deterrent: forty calls a day is fine and leaves
    // forty rows; a thousand leaves a thousand with a name against them.
    expect(Number(after!.n)).toBe(Number(before!.n) + 1);
  });
});
