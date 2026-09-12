/**
 * Hiding customer numbers from the team.
 *
 * The point of the feature is that a rep cannot walk out with the customer list,
 * so the assertion that matters is not "the screen shows xxxx" — it is that the
 * real number is **not in the response at all**. Masking in the interface would
 * pass a screenshot test and leave the number one devtools tab away from the
 * person it is hidden from.
 *
 * Since migration `099` the switch is a **field permission**, `owner_only`, set
 * per profile in Roles & Profiles rather than one global tick. That changes who
 * the subject of these tests has to be: the guarantee is now "everyone except
 * the record's owner", so the viewer being masked must be somebody who can open
 * the record and does not own it. A manager reading their own report's lead is
 * exactly that, and is the case the feature exists for — the rep working the
 * lead has to be able to ring it, and nobody above them needs the list.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { invalidatePermissions } from '../../src/core/permissions/index.js';
import { adminContext, signIn } from './fixtures.js';
import { maskNumber } from '../../src/core/permissions/maskPhones.js';

let app: Express;
/** Owns the lead. Under `owner_only` this is the one person who still sees it. */
let ownerToken: string;
/** Can open the lead through the role hierarchy, but does not own it. */
let managerToken: string;
let adminToken: string;
let leadId: string;
let mobileFieldId: string;
const profileIds: string[] = [];
const MOBILE = '9811421156';
const made: string[] = [];

/**
 * Turn the rule on or off for both profiles under test.
 *
 * Both, not just the manager's: the owner has to be subject to the same
 * permission for "the owner still sees it" to mean anything. If only the
 * manager's profile carried it, that test would pass with the feature deleted.
 */
async function setOwnerOnly(on: boolean): Promise<void> {
  if (on) {
    await db.query(
      `INSERT INTO ipy_profile_field_perm (profile_id, field_id, permission)
       SELECT unnest($1::uuid[]), $2::uuid, 'owner_only'
       ON CONFLICT (profile_id, field_id) DO UPDATE SET permission = 'owner_only'`,
      [profileIds, mobileFieldId],
    );
  } else {
    await db.query(
      `DELETE FROM ipy_profile_field_perm WHERE profile_id = ANY($1::uuid[]) AND field_id = $2`,
      [profileIds, mobileFieldId],
    );
  }
  invalidatePermissions();
}

beforeAll(async () => {
  await registry.warmup();
  app = createApp();

  const admin = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL
       AND email LIKE '%@%.%' ORDER BY created_at LIMIT 1`,
  );
  adminToken = await signIn(app, admin!.email);

  /*
    A pair where one can see the other's records without owning them, found
    through the **role hierarchy** — `ipy_role.path` holds a role's ancestors,
    and a role above another sees its records.

    Deliberately not `reports_to`: the seed never sets that column, and it is an
    admin's to configure, so a test keyed on it passes on a developer's own
    database and fails on a fresh one. Same trap the e2e suite already learned —
    assert on what the seed guarantees, discover the rest.
  */
  const pair = await db.queryOne<{
    owner_id: string; owner_email: string; owner_profile: string;
    manager_email: string; manager_profile: string;
  }>(
    `SELECT r.id AS owner_id, r.email AS owner_email, r.profile_id AS owner_profile,
            m.email AS manager_email, m.profile_id AS manager_profile
       FROM ipy_user r
       JOIN ipy_role rr ON rr.id = r.role_id
       JOIN ipy_user m ON m.role_id = ANY(rr.path)
      WHERE r.is_admin = false AND m.is_admin = false
        AND r.id <> m.id
        AND r.password_hash IS NOT NULL AND m.password_hash IS NOT NULL
        AND r.is_active AND m.is_active
        AND r.deleted_at IS NULL AND m.deleted_at IS NULL
        AND r.profile_id IS NOT NULL AND m.profile_id IS NOT NULL
        AND r.email LIKE '%@%.%' AND m.email LIKE '%@%.%'
      ORDER BY r.created_at LIMIT 1`,
  );
  if (!pair) throw new Error('no non-admin pair with one role above the other to test ownership against');

  ownerToken = await signIn(app, pair.owner_email);
  managerToken = await signIn(app, pair.manager_email);
  profileIds.push(...new Set([pair.owner_profile, pair.manager_profile]));

  const field = await db.queryOne<{ id: string }>(
    `SELECT f.id FROM ipy_field f JOIN ipy_module m ON m.id = f.module_id
      WHERE m.name = 'leads' AND f.name = 'mobile'`,
  );
  mobileFieldId = field!.id;

  const ctx = await adminContext();
  const rec = await recordService.createRecord(ctx, 'leads', {
    full_name: `Masking ${Date.now()}`, mobile: MOBILE, owner_id: pair.owner_id,
  });
  leadId = rec.id;
  made.push(rec.id);

  /*
    The precondition every test below rests on. If the hierarchy does not in
    fact let the non-owner open this record, the masking assertions still pass —
    a 403 contains no phone number either — and the suite would be green while
    testing nothing. Fail loudly here instead.
  */
  const reachable = await request(app)
    .get(`/api/records/leads/${leadId}`)
    .set('Authorization', `Bearer ${managerToken}`);
  if (reachable.status !== 200) {
    throw new Error(
      `the non-owner cannot open the record (${reachable.status}), so masking cannot be observed`,
    );
  }
});

afterAll(async () => {
  await setOwnerOnly(false);
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

  it('is off until a profile asks for it', async () => {
    await setOwnerOnly(false);
    const res = await request(app)
      .get(`/api/records/leads/${leadId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    expect(JSON.stringify(res.body)).toContain(MOBILE);
  });

  it('keeps the real number out of the response entirely, not just off the screen', async () => {
    await setOwnerOnly(true);
    const res = await request(app)
      .get(`/api/records/leads/${leadId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);

    // The assertion the whole feature rests on.
    expect(JSON.stringify(res.body)).not.toContain(MOBILE);
    expect(res.body.values.mobile).toBe('98xxxxxx56');
  });

  it('masks it on the list too, which is where a list would be copied from', async () => {
    await setOwnerOnly(true);
    const res = await request(app)
      .get('/api/records/leads?limit=100')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    expect(JSON.stringify(res.body)).not.toContain(MOBILE);
  });

  /**
   * The rule the global switch could not express, and the reason for the change:
   * the person actually working the lead still has the number.
   */
  it('leaves the record’s own owner reading it normally', async () => {
    await setOwnerOnly(true);
    const res = await request(app)
      .get(`/api/records/leads/${leadId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.values.mobile).toBe(MOBILE);
  });

  it('leaves an administrator seeing the real number', async () => {
    await setOwnerOnly(true);
    const res = await request(app)
      .get(`/api/records/leads/${leadId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.values.mobile).toBe(MOBILE);
  });

  it('still lets a rep get one number to call, and writes down that they did', async () => {
    await setOwnerOnly(true);
    const before = await db.queryOne<{ n: string }>(
      `SELECT count(*)::text AS n FROM ipy_audit WHERE record_id = $1 AND action = 'phone_revealed'`,
      [leadId],
    );

    const res = await request(app)
      .get(`/api/records/leads/${leadId}/phone/mobile`)
      .set('Authorization', `Bearer ${managerToken}`)
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

  /**
   * `owner_only` on something that is not a phone.
   *
   * Masking stopped being phone-specific in migration 099 — an admin can set
   * the permission on any field — and the reveal did not follow: it looked for
   * `uitype === 'phone'` and answered null for everything else. So a field of
   * any other type could be masked and then revealed by nobody, silently.
   *
   * Email is the case that bites, because `maskNumber` masks anything holding
   * six digits: `rakesh.kumar9876543@gmail.com` renders as `98xxx43`, which is
   * not a masked email so much as a destroyed one, and until this it could not
   * be got back.
   */
  it('reveals a masked field that is not a phone', async () => {
    const email = await db.queryOne<{ id: string }>(
      `SELECT f.id FROM ipy_field f JOIN ipy_module m ON m.id = f.module_id
        WHERE m.name = 'leads' AND f.name = 'email'`,
    );
    // A CRM whose admin has deleted the email field has nothing to assert.
    if (!email) return;

    // Digits on purpose: `maskNumber` only masks a value holding six of them,
    // so an address without any would never have been masked and would prove
    // nothing about the reveal.
    const address = 'rakesh.kumar9876543@example.com';
    await db.query(`UPDATE ipy_e_leads SET email = $2 WHERE record_id = $1`, [leadId, address]);

    await db.query(
      `INSERT INTO ipy_profile_field_perm (profile_id, field_id, permission)
       SELECT unnest($1::uuid[]), $2::uuid, 'owner_only'
       ON CONFLICT (profile_id, field_id) DO UPDATE SET permission = 'owner_only'`,
      [profileIds, email.id],
    );
    invalidatePermissions();

    try {
      const res = await request(app)
        .get(`/api/records/leads/${leadId}/phone/email`)
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status, 'a masked field the reveal cannot reach is masked for ever').toBe(200);
      expect(res.body.number).toBe(address);
    } finally {
      await db.query(
        `DELETE FROM ipy_profile_field_perm WHERE profile_id = ANY($1::uuid[]) AND field_id = $2::uuid`,
        [profileIds, email.id],
      );
      invalidatePermissions();
    }
  });

  /**
   * `hidden` and `owner_only` are different answers and the reveal endpoint has
   * to tell them apart — otherwise the audited escape hatch quietly becomes a
   * way around a field an admin refused outright.
   */
  it('refuses to reveal a field the profile hides altogether', async () => {
    await db.query(
      `INSERT INTO ipy_profile_field_perm (profile_id, field_id, permission)
       SELECT unnest($1::uuid[]), $2::uuid, 'hidden'
       ON CONFLICT (profile_id, field_id) DO UPDATE SET permission = 'hidden'`,
      [profileIds, mobileFieldId],
    );
    invalidatePermissions();

    const res = await request(app)
      .get(`/api/records/leads/${leadId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    expect(res.body.values.mobile).toBeUndefined();

    await request(app)
      .get(`/api/records/leads/${leadId}/phone/mobile`)
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(404);
  });
});
