/**
 * The back arrow on a record went nowhere, and the forward arrow was fine.
 *
 * `prevId` came back as the id of the record you were already on, so clicking
 * it reloaded the same page. He reported it as "previous doesn't work, next
 * does", and that asymmetry is the whole clue.
 *
 * Postgres keeps a timestamp to the microsecond; a JavaScript `Date` only to
 * the millisecond. So a `created_at` of `04:34:17.534234` reaches the neighbour
 * filter as `04:34:17.534`. On the default newest-first list, "previous" asks
 * for `created_at > .534000` — and `.534234` is greater than that, so every
 * record matched itself. "Next" asks for `< .534000`, which excludes it. One
 * arrow worked and one did not, for the sake of 234 microseconds.
 *
 * The equality tiebreak already in the filter could not help: the two values
 * are not equal once one of them has been truncated.
 *
 * Only a real database shows this. Any fixture that round-trips a timestamp
 * through JavaScript has already thrown the microseconds away, so the bug
 * cannot exist in it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { adminContext, signIn } from './fixtures.js';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';

let app: Express;
let token = '';
const made: string[] = [];

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  const ctx = await adminContext();
  token = await signIn(app, ctx.user.email);

  // Three in a known order. Created one at a time so their timestamps differ,
  // and left with whatever sub-millisecond precision Postgres gives them —
  // which is the entire point.
  for (let i = 0; i < 3; i += 1) {
    const lead = await recordService.createRecord(ctx, 'leads', {
      full_name: `Neighbour ${i} ${Date.now()}`,
      mobile: String(9811580000 + i + (Date.now() % 1000)),
    });
    made.push(lead.id);
    await new Promise((r) => { setTimeout(r, 25); });
  }
});

afterAll(async () => {
  if (made.length) await db.query(`DELETE FROM ipy_record WHERE id = ANY($1::uuid[])`, [made]);
});

async function neighbours(id: string) {
  const res = await request(app)
    .get(`/api/records/leads/${id}/neighbours?sort=created_at&dir=desc`)
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  return res.body as { prevId: string | null; nextId: string | null };
}

describe('the arrows on a record', () => {
  it('never point at the record you are already on', async () => {
    // The bug, stated as plainly as it deserves.
    for (const id of made) {
      const { prevId, nextId } = await neighbours(id);
      expect(prevId, 'previous pointed at itself, so the arrow reloaded the page').not.toBe(id);
      expect(nextId, 'next pointed at itself').not.toBe(id);
    }
  });

  it('go to the record above and the record below, in list order', async () => {
    /*
      Newest first, so of the three just made: made[2] is at the top, made[0] at
      the bottom. The middle one has a real neighbour on each side.
    */
    const [oldest, middle, newest] = made;
    const { prevId, nextId } = await neighbours(middle);
    expect(prevId, 'previous should be the newer record above it').toBe(newest);
    expect(nextId, 'next should be the older record below it').toBe(oldest);
  });

  it('survives timestamps that differ only below the millisecond', async () => {
    /*
      The exact shape of the original fault. Two records sharing a millisecond
      but not a microsecond: the truncated value is equal for both, so the
      comparison alone cannot separate them and the id tiebreak has to.
    */
    const ctx = await adminContext();
    const a = await recordService.createRecord(ctx, 'leads', {
      full_name: `Same ms A ${Date.now()}`, mobile: String(9811589001),
    });
    const b = await recordService.createRecord(ctx, 'leads', {
      full_name: `Same ms B ${Date.now()}`, mobile: String(9811589002),
    });
    made.push(a.id, b.id);

    await db.query(
      `UPDATE ipy_record SET created_at = timestamptz '2027-01-01 10:00:00.500111+00' WHERE id = $1`, [a.id]);
    await db.query(
      `UPDATE ipy_record SET created_at = timestamptz '2027-01-01 10:00:00.500777+00' WHERE id = $1`, [b.id]);

    for (const id of [a.id, b.id]) {
      const { prevId, nextId } = await neighbours(id);
      expect(prevId, 'a record matched itself on a truncated timestamp').not.toBe(id);
      expect(nextId).not.toBe(id);
    }
  });
});
