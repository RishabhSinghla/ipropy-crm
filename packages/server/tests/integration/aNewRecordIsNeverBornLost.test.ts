/**
 * A new record must not arrive with a Lost Reason.
 *
 * 16 October 2026, the owner: *"each lead coming from facebook automatically getting
 * filled its lost reason"*. Read off production, 3,340 contacts that were not lost
 * carried "Disqualified". The cause was one tapped star in Admin → Dropdowns: the
 * option was the dropdown's default, and every new record picks up its dropdown's
 * default — Facebook, the website, a rep typing one in, all alike.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { adminContext, leadInput, signIn } from './fixtures.js';

const stamp = Date.now();
let ctx: Awaited<ReturnType<typeof adminContext>>;
let app: Express;
let token: string;
let reason: string;
let wasDefault: boolean;
const created: string[] = [];

beforeAll(async () => {
  ctx = await adminContext();
  app = createApp();
  token = await signIn(app, 'admin@ipropy.com');
  const option = await db.queryOne<{ value: string; is_default: boolean }>(
    `SELECT v.value, v.is_default FROM ipy_picklist_value v JOIN ipy_picklist p ON p.id = v.picklist_id
      WHERE p.name = 'lost_reason' ORDER BY v.sequence LIMIT 1`,
  );
  reason = option!.value;
  wasDefault = option!.is_default;
});

afterAll(async () => {
  await db.query(
    `UPDATE ipy_picklist_value SET is_default = $2 WHERE value = $1 AND picklist_id = (SELECT id FROM ipy_picklist WHERE name = 'lost_reason')`,
    [reason, wasDefault],
  );
  registry.invalidate();
  for (const id of created) await db.query(`DELETE FROM ipy_record WHERE id = $1`, [id]).catch(() => undefined);
});

describe('a Lost Reason is never filled in for a new record', () => {
  it('ignores a default that somebody starred on the dropdown', async () => {
    await db.query(
      `UPDATE ipy_picklist_value SET is_default = (value = $1) WHERE picklist_id = (SELECT id FROM ipy_picklist WHERE name = 'lost_reason')`,
      [reason],
    );
    registry.invalidate();
    const lead = await recordService.createRecord(ctx, 'leads', leadInput({ full_name: `Born Lost ${stamp}` }));
    created.push(lead.id);
    expect(lead.values.lost_reason ?? null).toBeNull();
  });

  it('refuses to save a default on that dropdown, however the editor asks', async () => {
    const current = await request(app).get('/api/meta/picklists/lost_reason').set('Authorization', `Bearer ${token}`);
    const values = current.body as Array<{ value: string; label: string; color?: string | null; isActive: boolean; meta?: object }>;
    const sending = values.map((v, i) => ({ value: v.value, label: v.label, color: v.color ?? null, isActive: v.isActive, isDefault: i === 0, meta: v.meta ?? {} }));
    const saved = await request(app).put('/api/meta/picklists/lost_reason/values').set('Authorization', `Bearer ${token}`).send({ values: sending });
    expect(saved.status).toBe(200);
    const stillDefault = await db.query(
      `SELECT 1 FROM ipy_picklist_value v JOIN ipy_picklist p ON p.id = v.picklist_id WHERE p.name = 'lost_reason' AND v.is_default`,
    );
    expect(stillDefault.rows).toHaveLength(0);
  });
});
