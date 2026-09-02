/**
 * Every way into a record is guarded, not just the front door.
 *
 * A record has a dozen sub-resources — its timeline, comments, audit trail,
 * share links, tags, phone reveal — and each is a separate route with its own
 * access check. Eleven had one. `/shares` did not, and answered 200 to anybody
 * signed in about any record at all.
 *
 * What it gave away is narrow and real: that a record with a given id exists,
 * and the people and teams it has been shared with. On a CRM where leads are
 * private by default, that is the sharing graph of somebody else's pipeline.
 *
 * A per-route check is easy to forget on the twelfth route, so this walks all of
 * them rather than testing the one that was wrong.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { SEEDED, adminContext } from './fixtures.js';

let app: Express;
let outsiderToken: string;
let foreignRecord: string;
let created: string | null = null;

beforeAll(async () => {
  await registry.warmup();
  app = createApp();

  const login = await request(app).post('/api/auth/login')
    .send({ email: SEEDED.executiveA, password: 'Admin@123' });
  outsiderToken = login.body.token;

  /*
    Created through the real service rather than a hand-written INSERT — the
    first version of this file missed a NOT NULL column and the whole suite
    skipped, which is a test file failing quietly at exactly the thing it exists
    to stop happening elsewhere.
  */
  const ctx = await adminContext();
  const lead = await recordService.createRecord(ctx, 'leads', {
    full_name: 'Permission Probe',
    mobile: '9811500999',
    status: 'New',
  });
  created = lead.id;
  foreignRecord = created;
});

afterAll(async () => {
  if (created) await db.query(`DELETE FROM ipy_record WHERE id = $1`, [created]);
});

describe('a record somebody else owns', () => {
  it.each([
    ['the record itself', ''],
    ['its timeline', '/timeline'],
    ['its comments', '/comments'],
    ['its audit trail', '/audit'],
    ['its share links', '/share-links'],
    ['who it is shared with', '/shares'],
  ])('refuses %s', async (_what, path) => {
    const res = await request(app)
      .get(`/api/records/leads/${foreignRecord}${path}`)
      .set('Authorization', `Bearer ${outsiderToken}`);

    expect(
      res.status,
      `${path || '/record'} answered ${res.status} — every route into a record needs its own check`,
    ).toBe(403);
  });

  it('does not confirm the record exists by answering differently', async () => {
    /*
      A 403 on a real id and a 403 on an invented one must look the same, or the
      difference between them is a way to enumerate what exists.
    */
    const real = await request(app).get(`/api/records/leads/${foreignRecord}/shares`)
      .set('Authorization', `Bearer ${outsiderToken}`);
    const invented = await request(app)
      .get('/api/records/leads/00000000-0000-0000-0000-000000000000/shares')
      .set('Authorization', `Bearer ${outsiderToken}`);

    expect(real.status).toBe(invented.status);
  });
});
