/**
 * Searching a phone number must not name an archived contact as somebody else's.
 *
 * **17 October 2026, the owner, signed in as an administrator:** searched a
 * mobile number and was told *"Already in Leads, assigned to … Not shared with
 * you."* The contact was Lost and archived (migration 201) — gone from every
 * list on purpose — but the phone-number lookup, written
 * earlier, never learned that rule, so it still found the record and showed it
 * as a locked row to everybody, administrators included.
 *
 * The control matters as much as the fix: a *live* contact that belongs to
 * somebody else must still be named to a rep who cannot open it. That is the
 * doorbell the 3 October feature exists for, and removing it would be the
 * opposite mistake.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { contextFor, leadInput, signIn, SEEDED } from './fixtures.js';

let app: Express;
let admin = '';
let stranger = '';
let recordId = '';
let mobile = '';

async function searchFor(token: string): Promise<Array<Record<string, unknown>>> {
  const res = await request(app).get('/api/search').query({ q: mobile })
    .set('Authorization', `Bearer ${token}`).expect(200);
  return res.body as Array<Record<string, unknown>>;
}

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  admin = await signIn(app, 'admin@ipropy.com');
  stranger = await signIn(app, SEEDED.executiveB);
  // Leads are private, so executive B cannot open one owned by executive A.
  const input = leadInput();
  mobile = String(input.mobile);
  const made = await recordService.createRecord(await contextFor(SEEDED.executiveA), 'leads', input);
  recordId = made.id;
});

describe('searching a phone number', () => {
  it('names a live contact that belongs to somebody else, as a doorbell and nothing more', async () => {
    const hits = await searchFor(stranger);
    expect(hits.some((hit) => hit.restricted === true), 'the colleague\'s customer should be named').toBe(true);
  });

  it('shows an administrator the real contact, not a locked row', async () => {
    const hits = await searchFor(admin);
    const real = hits.find((hit) => hit.id === recordId);
    expect(real, 'an administrator can open every contact').toBeTruthy();
    expect(real!.restricted).toBeFalsy();
  });

  it('names an archived contact to nobody who cannot open it, and shows an administrator the real record marked archived', async () => {
    await db.query('UPDATE ipy_record SET archived_at = now() WHERE id = $1', [recordId]);
    try {
      // 24 October 2026: archived records are found by search now, but only inside the searcher's own scope.
      expect(await searchFor(stranger)).toEqual([]);
      const hit = (await searchFor(admin)).find((item) => item.id === recordId);
      expect(hit, 'an administrator can open an archived contact').toBeTruthy();
      expect(hit!.archived).toBe(true);
      expect(hit!.restricted).toBeFalsy();
    } finally {
      await db.query('UPDATE ipy_record SET archived_at = NULL WHERE id = $1', [recordId]);
    }
  });

  it('lists archived matches after every live one', async () => {
    const token = `Archsort${Date.now().toString(36)}`;
    const ctx = await contextFor(SEEDED.executiveA);
    const archivedOne = await recordService.createRecord(ctx, 'leads', leadInput({ full_name: `${token} Old` }));
    const liveOne = await recordService.createRecord(ctx, 'leads', leadInput({ full_name: `${token} Live` }));
    // The archived one was touched most recently, so a plain recency sort would put it first.
    await db.query('UPDATE ipy_record SET archived_at = now(), updated_at = now() + interval \'1 minute\' WHERE id = $1', [archivedOne.id]);
    try {
      const res = await request(app).get('/api/search').query({ q: token }).set('Authorization', `Bearer ${admin}`).expect(200);
      const ids = (res.body as Array<{ id: string }>).map((hit) => hit.id);
      expect(ids.indexOf(liveOne.id)).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf(liveOne.id)).toBeLessThan(ids.indexOf(archivedOne.id));
    } finally {
      await db.query('UPDATE ipy_record SET archived_at = NULL WHERE id = $1', [archivedOne.id]);
    }
  });
});
