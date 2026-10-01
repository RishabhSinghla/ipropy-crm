/**
 * Old phones can be cleared away, and their calls stay.
 *
 * The owner, 1 October 2026, of Settings → Phones: *"no delete button why …
 * it looks terrifying"*. Every reinstall paired one Samsung again, so the list
 * held a dozen rows for it. Clean-up removes revoked phones, phones that never
 * once connected, and older pairings of a handset heard from since — only the
 * asking person's own unless they are an admin — and a call a removed phone
 * logged stays on its record.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { SEEDED, signIn } from './fixtures.js';

let app: Express;
let token = '';
let mine = '';
let someoneElse = '';
const made: string[] = [];
let callId = '';

async function phone(userId: string, values: { model?: string; active?: boolean; createdAgo?: string; seenAgo?: string | null }): Promise<string> {
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_device (user_id, label, model, token_hash, is_active, created_at, last_seen_at)
     VALUES ($1, 'Test phone', $2, $3, $4, now() - $5::interval,
             CASE WHEN $6::text IS NULL THEN NULL ELSE now() - $6::interval END)
     RETURNING id`,
    [userId, values.model ?? 'Clean-up Test Model', `test-${randomUUID()}`, values.active ?? true, values.createdAgo ?? '0 seconds', values.seenAgo ?? null],
  );
  made.push(row!.id);
  return row!.id;
}

async function exists(id: string): Promise<boolean> {
  return Boolean(await db.queryOne(`SELECT 1 FROM ipy_device WHERE id = $1`, [id]));
}

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  token = await signIn(app, SEEDED.executiveB);
  mine = (await db.queryOne<{ id: string }>(`SELECT id FROM ipy_user WHERE email = $1`, [SEEDED.executiveB]))!.id;
  someoneElse = (await db.queryOne<{ id: string }>(`SELECT id FROM ipy_user WHERE email = $1`, [SEEDED.executiveA]))!.id;
});

afterAll(async () => {
  if (callId) await db.query(`DELETE FROM ipy_call WHERE id = $1`, [callId]);
  await db.query(`DELETE FROM ipy_device WHERE id = ANY($1::uuid[])`, [made]);
});

describe('cleaning up old phones', () => {
  it('removes the stale ones, keeps the one in use, and keeps their calls', async () => {
    const current = await phone(mine, { createdAgo: '1 hour', seenAgo: '1 minute' });
    const olderPairing = await phone(mine, { createdAgo: '3 days', seenAgo: '3 days' });
    const neverConnected = await phone(mine, { model: 'Another Model', createdAgo: '2 days' });
    const justPaired = await phone(mine, { model: 'Brand New Model' });
    const revoked = await phone(mine, { model: 'Old Revoked Model', active: false, createdAgo: '1 hour', seenAgo: '1 hour' });
    const notMine = await phone(someoneElse, { model: 'Another Model', createdAgo: '2 days' });

    const call = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_call (direction, status, from_number, to_number, device_id, user_id, started_at)
       VALUES ('outbound', 'completed', '+919800000001', '+919800000002', $1, $2, now()) RETURNING id`,
      [olderPairing, mine],
    );
    callId = call!.id;

    const res = await request(app).post('/api/telephony/devices/clean-up')
      .set('Authorization', `Bearer ${token}`).send({}).expect(200);
    expect(res.body.removed).toBeGreaterThanOrEqual(3);

    expect(await exists(current)).toBe(true);
    expect(await exists(justPaired)).toBe(true);
    expect(await exists(olderPairing)).toBe(false);
    expect(await exists(neverConnected)).toBe(false);
    expect(await exists(revoked)).toBe(false);
    expect(await exists(notMine), "a rep's clean-up must not touch a colleague's phone").toBe(true);

    const kept = await db.queryOne<{ device_id: string | null }>(`SELECT device_id FROM ipy_call WHERE id = $1`, [callId]);
    expect(kept, 'the call a removed phone logged is still there').toBeTruthy();
    expect(kept!.device_id).toBeNull();
  });

  it('deletes one phone for good, only your own', async () => {
    const yours = await phone(mine, { model: 'Delete Me Model' });
    const theirs = await phone(someoneElse, { model: 'Not Yours Model' });
    await request(app).delete(`/api/telephony/devices/${theirs}/permanently`)
      .set('Authorization', `Bearer ${token}`).expect(404);
    expect(await exists(theirs)).toBe(true);
    await request(app).delete(`/api/telephony/devices/${yours}/permanently`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(await exists(yours)).toBe(false);
  });
});
