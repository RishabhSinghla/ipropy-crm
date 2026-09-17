/**
 * The three facts a rep reads off a list row without stopping.
 *
 * A follow-up date drawn as "15 Sept 2026" makes somebody count on their
 * fingers; "Overdue (2d)" does not. A name with no second line costs two more
 * columns to say "buyer" and "B-118". Both are decided by flags on the field
 * rather than by names compiled into the web app — which dates chase somebody,
 * and which two facts identify a record, are this business's decisions.
 *
 * This pins the half the browser cannot: that the flags exist on a database
 * that already had these fields, and that they reach the client. Migration 151
 * sets them; the seed sets them for a fresh install. A chip that quietly stops
 * appearing because a config key was dropped is invisible in a screenshot.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { signIn } from './fixtures.js';

let app: ReturnType<typeof createApp>;
let token = '';

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  const admin = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`);
  token = await signIn(app, admin!.email);
});

const describeModule = async (name: string): Promise<{ name: string; config?: Record<string, unknown> }[]> => {
  const res = await request(app).get(`/api/meta/modules/${name}`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body.fields as { name: string; config?: Record<string, unknown> }[];
};

describe('a follow-up date', () => {
  it('is marked as a due date, so the list can say how late it is', async () => {
    const followUp = (await describeModule('leads')).find((f) => f.name === 'next_followup_at');
    expect(followUp, 'leads should still carry a follow-up date').toBeDefined();
    expect(followUp!.config?.dueDate, 'without this the list draws a plain date again').toBe(true);
  });

  it('does not mark every date — a birthday is never overdue', async () => {
    const fields = await describeModule('leads');
    const dated = fields.filter((f) => f.config?.dueDate);
    expect(dated.map((f) => f.name)).toEqual(['next_followup_at']);
  });
});

describe('the line under a name in a list', () => {
  it('names the contact type on leads', async () => {
    const contactType = (await describeModule('leads')).find((f) => f.name === 'contact_type');
    expect(contactType, 'leads should still carry a contact type').toBeDefined();
    // The flag carries a position now — a number is that position, `true` still
    // means "include me". Asserting `=== true` pinned the shape the seed had
    // before it named an order, not the promise this file is about.
    expect(contactType!.config?.listSubtitle).toBeTruthy();
  });

  it('names the unit number on properties', async () => {
    const unit = (await describeModule('properties')).find((f) => f.name === 'unit_number');
    expect(unit, 'properties should still carry a unit number').toBeDefined();
    expect(unit!.config?.listSubtitle).toBeTruthy();
  });

  it('stays a short line — two facts, not a second row of the record', async () => {
    for (const module of ['leads', 'properties']) {
      const flagged = (await describeModule(module)).filter((f) => f.config?.listSubtitle);
      expect(flagged.length, `${module} should keep its subtitle to a couple of facts`).toBeLessThanOrEqual(3);
    }
  });
});
