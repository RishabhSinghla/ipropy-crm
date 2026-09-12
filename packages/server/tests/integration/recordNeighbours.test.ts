/**
 * Neighbours: the records either side of this one in the list the user came
 * from.
 *
 * The arrows on the record header used to read a stash the list page left in
 * sessionStorage, which held only the last rendered page — a record opened
 * from search, a notification or a pasted URL was in no list and both arrows
 * went dead. The neighbours endpoint answers from the saved view and sort the
 * back button carries instead.
 *
 * The itest database is seeded with demo leads whose budgets run into crores,
 * well above this suite's ₹100–₹500 fixtures — so "the previous record in a
 * descending list" is not always one of the five rows made here, and the
 * assertions fetch the neighbour's value rather than assume the fixture set
 * is the whole world.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { createApp } from '../../src/app.js';
import { adminContext, signIn } from './fixtures.js';

let app: Express;
let adminToken: string;
const made: string[] = [];

beforeAll(async () => {
  await registry.warmup();
  app = createApp();

  const admin = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`,
  );
  adminToken = await signIn(app, admin!.email);

  const budgets = [100, 200, 300, 400, 500];
  for (let i = 0; i < budgets.length; i++) {
    const lead = await recordService.createRecord(await adminContext(), 'leads', {
      full_name: `Neighbour ${i} ${Date.now()}`,
      mobile: `9${String(900000000 + i * 7 + Date.now() % 100000000).slice(-9)}`,
      budget: budgets[i],
    });
    made.push(lead.id);
  }
});

afterAll(async () => {
  // By marker rather than by remembered id: a killed run (timeout, crash)
  // never reaches its own cleanup, and its leftovers would otherwise sit in
  // the shared throwaway database poisoning the next run's expectations.
  await db.query(
    `DELETE FROM ipy_record WHERE id IN (
       SELECT l.record_id FROM ipy_e_leads l WHERE l.full_name LIKE 'Neighbour %'
     )`,
  );
});

async function budgetOf(id: string): Promise<number | null> {
  const res = await request(app)
    .get(`/api/records/leads/${id}`)
    .set('Authorization', `Bearer ${adminToken}`);
  const v = res.body?.values?.budget;
  return v === null || v === undefined ? null : Number(v);
}

const neighbours = (id: string, query: string): Promise<{ status: number; body: { prevId: string | null; nextId: string | null } }> =>
  request(app)
    .get(`/api/records/leads/${id}/neighbours${query}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .then((r) => ({ status: r.status, body: r.body }));

describe('record neighbours', () => {
  it('walks a sorted list one record at a time, both directions', async () => {
    // Descending by budget. C (₹300) is bracketed by D (₹400) and B (₹200):
    // the nearest values either side, however many crore leads tower above.
    const res = await neighbours(made[2], '?sort=budget&dir=desc');
    expect(res.status).toBe(200);
    expect(await budgetOf(res.body.prevId!)).toBe(400);
    expect(await budgetOf(res.body.nextId!)).toBe(200);
  });

  it('reverses the answer when the list runs ascending', async () => {
    const res = await neighbours(made[2], '?sort=budget&dir=asc');
    expect(await budgetOf(res.body.prevId!)).toBe(200);
    expect(await budgetOf(res.body.nextId!)).toBe(400);
  });

  it('reaches past the fixtures into the rest of the list', async () => {
    // ₹500 is the largest fixture, but demo leads with crore budgets sort
    // above it in a descending list. Previous is whichever of those is
    // closest; there is nothing at all above it.
    const top = await neighbours(made[4], '?sort=budget&dir=desc');
    expect(await budgetOf(top.body.prevId!)).toBeGreaterThan(500);
    expect(await budgetOf(top.body.nextId!)).toBe(400);
  });

  it('leaves the true end of the list with one working arrow', async () => {
    // ₹100 is the smallest budget anywhere, so a descending list ends here:
    // the previous arrow still works (₹200 sits one step above), next is dead.
    const bottom = await neighbours(made[0], '?sort=budget&dir=desc');
    expect(await budgetOf(bottom.body.prevId!)).toBe(200);
    expect(bottom.body.nextId).toBeNull();
  });

  it('answers nothing for a record whose sort value is blank', async () => {
    const blank = await recordService.createRecord(await adminContext(), 'leads', {
      full_name: `Neighbour blank ${Date.now()}`,
      mobile: `9${String(900000000 + Date.now() % 100000000).slice(-9)}`,
    });
    made.push(blank.id);

    const res = await neighbours(blank.id, '?sort=budget&dir=desc');
    expect(res.status).toBe(200);
    expect(res.body.prevId).toBeNull();
    expect(res.body.nextId).toBeNull();
  });

  it('refuses a stranger asking about someone else\'s record', async () => {
    const res = await request(app)
      .get(`/api/records/leads/${made[0]}/neighbours`)
      .expect(401);
    expect(res.status).toBe(401);
  });
});
