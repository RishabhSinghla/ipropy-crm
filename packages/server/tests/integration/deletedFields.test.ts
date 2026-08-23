/**
 * Deleting a field must not take part of the CRM down with it.
 *
 * This is the whole promise of the thing: an administrator can remove a field
 * they do not use, from the admin panel, without a developer. What actually
 * happened was that several queries listed their columns by hand, so removing
 * one turned the query into `column "..." does not exist`. Postgres answers
 * 42703, the API turns it into a 400, and something visible stops working.
 *
 * Two real instances, both live on his CRM at once and both found by opening a
 * lead and looking at the network tab rather than by any test:
 *
 *  * `leads.interested_project` was gone, so property matching answered 400 on
 *    every lead in the system.
 *  * the public website's property list hand-picks forty columns, and losing
 *    any one of them took the whole catalogue offline.
 *
 * Neither reported the field it was missing, and neither could have, because
 * deleting a field the admin panel offers to delete is not an error. The fix in
 * both cases was to stop hand-listing columns that somebody is allowed to
 * remove. These tests drop a column for real and assert the app carries on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { loadRequirement } from '../../src/ai/matching.js';
import { invalidatePublicFields } from '../../src/api/routes/public.js';
import { adminContext } from './fixtures.js';
import { recordService } from '../../src/core/entity/recordService.js';

let app: Express;
let adminToken: string;
const dropped: { table: string; column: string; type: string }[] = [];

async function dropColumn(table: string, column: string, type: string): Promise<void> {
  await db.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS ${column}`);
  dropped.push({ table, column, type });
  invalidatePublicFields();
  registry.invalidate();
}

beforeAll(async () => {
  await registry.warmup();
  app = createApp();

  const admin = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL
      ORDER BY created_at LIMIT 1`,
  );
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: admin!.email, password: 'Admin@123' });
  adminToken = res.body.token as string;
});

afterAll(async () => {
  // Put them back: `fileParallelism: false` means later files share this
  // database, and a missing column would surface there as an unrelated mystery.
  for (const { table, column, type } of dropped) {
    await db.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`);
  }
  invalidatePublicFields();
  registry.invalidate();
});

describe('a lead field somebody removed', () => {
  it('does not stop property matching', async () => {
    const ctx = await adminContext();
    const lead = await recordService.createRecord(ctx, 'leads', {
      full_name: 'Requirement Survives',
      mobile: `9${String(Date.now()).slice(-9)}`,
      budget_min: 5_000_000,
      budget_max: 9_000_000,
    });

    // Works before.
    expect(await loadRequirement(lead.id)).not.toBeNull();

    await dropColumn('ipy_e_leads', 'interested_project', 'TEXT');

    // And still works after, which is the point. Before the fix this threw
    // 42703 and property matching answered 400 on every lead in the CRM.
    const requirement = await loadRequirement(lead.id);
    expect(requirement).not.toBeNull();
    expect(requirement?.budgetMin).toBe(5_000_000);
    // The removed field reads as absent rather than exploding.
    expect(requirement?.projectName ?? null).toBeNull();
  });
});

describe('the fields the engine reads', () => {
  it('refuses to delete one, and says what to do instead', async () => {
    // The hole this suite exists because of. Renaming these was already
    // refused; deleting one was not, and deleting is the worse of the two.
    const field = await db.queryOne<{ id: string }>(
      `SELECT f.id FROM ipy_field f JOIN ipy_module m ON m.id = f.module_id
        WHERE m.name = 'leads' AND f.name = 'budget_min'`,
    );
    expect(field).toBeTruthy();

    const res = await request(app)
      .delete(`/api/meta/fields/${field!.id}?permanent=true`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/reads it directly/i);
    // And it tells them the thing that does work, rather than just saying no.
    expect(res.body.message).toMatch(/hide it instead/i);

    const survived = await db.queryOne(`SELECT 1 FROM ipy_field WHERE id = $1`, [field!.id]);
    expect(survived).toBeTruthy();
  });
});

describe('a property field somebody removed', () => {
  it('does not take the public website catalogue down', async () => {
    const before = await request(app).get('/api/public/properties?limit=2');
    expect(before.status).toBe(200);

    await dropColumn('ipy_e_properties', 'view_description', 'TEXT');

    const after = await request(app).get('/api/public/properties?limit=2');
    expect(after.status).toBe(200);
    expect(Array.isArray(after.body.items)).toBe(true);

    // Still a whitelist, and the removed field is simply not in the answer.
    for (const item of after.body.items) {
      expect(item).not.toHaveProperty('view_description');
    }
  });

  it('still refuses to hand out a field that was never on the list', async () => {
    // The reason the list exists. Losing a field must not turn the whitelist
    // into "everything that happens to be on the table".
    const res = await request(app).get('/api/public/properties?limit=2');
    expect(res.status).toBe(200);
    for (const item of res.body.items) {
      for (const secret of ['owner_contact', 'broker_commission_pct', 'blocked_for_lead']) {
        expect(item).not.toHaveProperty(secret);
      }
    }
  });
});
