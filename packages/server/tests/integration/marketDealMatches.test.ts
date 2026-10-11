/**
 * A dealer-group deal finds the contacts it fits, tells their owner, and shows
 * each person only the records they may open.
 *
 * The match reads payload columns through fieldText/fieldJson, as a string of
 * SQL — typecheck cannot see a wrong column and a mocked query accepts
 * anything, so only a real database can prove it runs.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { db } from '../../src/db/pool.js';
import { adminContext, authUser, leadInput, signIn, SEEDED } from './fixtures.js';

let app: Express;
let adminToken = '';
let ownerToken = '';
let otherToken = '';
let leadId = '';
let ownerId = '';
let locality = '';
const marker = `itestmatch${Date.now()}`;

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  adminToken = await signIn(app, 'admin@ipropy.com');
  ownerToken = await signIn(app, SEEDED.executiveA);
  otherToken = await signIn(app, SEEDED.executiveB);
  ownerId = (await authUser(SEEDED.executiveA)).id;

  const known = await db.queryOne<{ value: string }>(
    `SELECT v.value FROM ipy_picklist p JOIN ipy_picklist_value v ON v.picklist_id = p.id
      WHERE p.name = 'locality' AND v.is_active AND length(v.value) > 4 ORDER BY v.value LIMIT 1`,
  );
  locality = known!.value;

  const lead = await recordService.createRecord(await adminContext(), 'leads', leadInput({
    full_name: `Buyer ${marker}`,
    preferred_locations: [locality],
    configuration: ['3 BHK'],
    budget: 16_000_000,
    owner_id: ownerId,
  }));
  leadId = lead.id;
});

function exportFor(body: string): string {
  const now = new Date();
  return `${now.getDate()}/${now.getMonth() + 1}/${now.getFullYear()}, 9:00 am - Ramesh Dealer: ${body}`;
}

describe('matching a dealer-group deal', () => {
  it('a fresh seller deal alerts the owner of a contact it fits', async () => {
    const res = await request(app)
      .post('/api/market/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('group', 'Match Group')
      .attach('file', Buffer.from(exportFor(`3 BHK available in ${locality} ${marker}, 1.45 Cr`), 'utf8'), 'chat.txt');
    expect(res.status).toBe(200);
    expect(res.body.newDeals).toBe(1);
    expect(res.body.alerted).toBeGreaterThanOrEqual(1);

    const told = await db.queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM ipy_notification WHERE user_id = $1 AND kind = 'market_match' AND body ILIKE $2`,
      [ownerId, `%${marker}%`],
    );
    expect(told?.n).toBe(1);
  });

  it('shows the match to its owner and not to a colleague who cannot open the contact', async () => {
    const post = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_market_post WHERE body ILIKE $1`, [`%${marker}%`]);
    const mine = await request(app).get(`/api/market/posts/${post!.id}/matches`).set('Authorization', `Bearer ${ownerToken}`);
    expect(mine.status).toBe(200);
    expect(mine.body.map((m: { recordId: string }) => m.recordId)).toContain(leadId);

    const theirs = await request(app).get(`/api/market/posts/${post!.id}/matches`).set('Authorization', `Bearer ${otherToken}`);
    expect(theirs.status).toBe(200);
    const canOpen = await request(app).get(`/api/records/leads/${leadId}`).set('Authorization', `Bearer ${otherToken}`);
    // Two executives at the same level: neither can open the other's contacts.
    expect(canOpen.status).not.toBe(200);
    expect(theirs.body.map((m: { recordId: string }) => m.recordId)).not.toContain(leadId);
  });

  it('a deal priced well above the budget does not match', async () => {
    await request(app)
      .post('/api/market/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('group', 'Match Group')
      .attach('file', Buffer.from(exportFor(`3 BHK available in ${locality} ${marker} premium, 4 Cr`), 'utf8'), 'chat.txt');
    const post = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_market_post WHERE body ILIKE $1`, [`%${marker} premium%`]);
    const res = await request(app).get(`/api/market/posts/${post!.id}/matches`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.body.map((m: { recordId: string }) => m.recordId)).not.toContain(leadId);
  });
});
