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

/**
 * The neighbour the endpoint *must* answer with, worked out from the data.
 *
 * The assertions used to be the fixture numbers: ₹300 is bracketed by ₹400 and
 * ₹200. That holds only while nothing else in the suite owns a lead with a
 * budget in between, and the suite creates leads constantly — so this test
 * failed once in five full runs, saying the arrows were wrong when they were
 * right and the list had simply changed underneath it.
 *
 * Asking the database instead makes the assertion about the endpoint agreeing
 * with the data, which is the actual promise, and it holds whatever else is in
 * there. `>=` rather than `>`, excluding this record by id, so a second lead on
 * the same budget is a legitimate neighbour rather than a failure.
 */
async function closestBudget(
  self: string,
  budget: number,
  side: 'above' | 'below',
): Promise<number | null> {
  const row = await db.queryOne<{ edge: string | null }>(
    `SELECT ${side === 'above' ? 'MIN' : 'MAX'}(b)::text AS edge
       FROM (
         SELECT ipy_try_numeric(to_jsonb(l)->>'budget') AS b
           FROM ipy_e_leads l
           JOIN ipy_record r ON r.id = l.record_id
          WHERE r.is_deleted = false AND r.id <> $1
       ) x
      WHERE b IS NOT NULL AND b ${side === 'above' ? '>=' : '<='} $2`,
    [self, budget],
  );
  return row?.edge === null || row?.edge === undefined ? null : Number(row.edge);
}

describe('record neighbours', () => {
  it('walks a sorted list one record at a time, both directions', async () => {
    // Descending by budget: previous is the nearest budget at or above this
    // one, next is the nearest at or below — whatever else the suite has put
    // in the list by the time this runs.
    const res = await neighbours(made[2], '?sort=budget&dir=desc');
    expect(res.status).toBe(200);
    expect(await budgetOf(res.body.prevId!)).toBe(await closestBudget(made[2], 300, 'above'));
    expect(await budgetOf(res.body.nextId!)).toBe(await closestBudget(made[2], 300, 'below'));
  });

  it('reverses the answer when the list runs ascending', async () => {
    const res = await neighbours(made[2], '?sort=budget&dir=asc');
    expect(await budgetOf(res.body.prevId!)).toBe(await closestBudget(made[2], 300, 'below'));
    expect(await budgetOf(res.body.nextId!)).toBe(await closestBudget(made[2], 300, 'above'));
  });

  it('reaches past the fixtures into the rest of the list', async () => {
    // ₹500 is the largest fixture, and the demo data has leads in crores that
    // sort above it — so the arrow must leave this test's own five records
    // rather than stopping at the edge of them.
    const above = await closestBudget(made[4], 500, 'above');
    expect(above, 'the demo seed should hold a lead richer than ₹500').not.toBeNull();

    const top = await neighbours(made[4], '?sort=budget&dir=desc');
    expect(await budgetOf(top.body.prevId!)).toBe(above);
    expect(await budgetOf(top.body.nextId!)).toBe(await closestBudget(made[4], 500, 'below'));
  });

  it('leaves the true end of the list with one working arrow', async () => {
    // A descending list ends at the smallest budget there is. Which record
    // that is depends on what else the suite has created, so ask.
    const below = await closestBudget(made[0], 100, 'below');

    const bottom = await neighbours(made[0], '?sort=budget&dir=desc');
    expect(await budgetOf(bottom.body.prevId!)).toBe(await closestBudget(made[0], 100, 'above'));
    if (below === null) expect(bottom.body.nextId, 'nothing sits below the end of the list').toBeNull();
    else expect(await budgetOf(bottom.body.nextId!)).toBe(below);
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
