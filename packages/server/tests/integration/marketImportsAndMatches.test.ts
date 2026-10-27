/**
 * The dealer-group import and the introductions, the way the owner uses them:
 * many files at once, named from their files, read only from where the group
 * was last read to, and every pairing judged twice before it reaches the call
 * sheet — by the rules, then by Jev, and by the people who ring.
 *
 * Reading, matching and writing a pairing's outcome are SQL in strings; only a
 * real database proves the columns exist.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

// Only the key lookup is faked, so the reader behaves as if OpenRouter were connected.
vi.mock('../../src/core/settings/integrations.js', async (original) => ({
  ...(await original<typeof import('../../src/core/settings/integrations.js')>()),
  getAiProviderSettings: () => ({ apiKey: 'test-key' }),
}));

import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { signIn } from './fixtures.js';
import { importGroupExport } from '../../src/core/market/feed.js';
import { findCrossMatches, recordOutcome } from '../../src/core/market/crossMatch.js';
import { ZipArchive } from 'archiver';
import { marketWork, verifyPairs } from '../../src/core/market/enrich.js';

/*
  Built at run time with today's date. It used to be a fixed archive dated 12/10/2026; the feed keeps only the last
  15 days, so the day that file aged out the test started failing with no code change behind it.
*/
let ZIP: Buffer;
async function buildZip(date: string): Promise<Buffer> {
  const zip = new ZipArchive();
  const chunks: Buffer[] = [];
  zip.on('data', (c: Buffer) => chunks.push(c));
  const finished = new Promise<void>((resolve, reject) => { zip.on('end', resolve); zip.on('error', reject); });
  zip.append(
    `${date}, 9:00 am - Zed Alpha: Available for sale 3 BHK in Sector 91 zipmark 1.2 Cr call 9701234501
${date}, 9:05 am - Yan Alpha: Required 250 gaj plot Sector 92 zipmark budget 4 cr call 9701234502
`,
    { name: 'WhatsApp Chat - ZIPMARK Alpha Dealers/_chat.txt' },
  );
  zip.append(`${date}, 10:00 am - Xen Beta: 200 gaj plot for sale Sector 93 zipmark 3 cr call 9701234503
`, { name: 'WhatsApp Chat with ZIPMARK Beta Dealers.txt' });
  await zip.finalize();
  await finished;
  return Buffer.concat(chunks);
}

let app: Express;
let adminToken = '';
let adminId = '';
const marker = `itestimp${Date.now()}`;
const day = (() => {
  const now = new Date();
  return `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
})();
// One base per run, so the same label is the same number all the way through.
const runDigits = String(Date.now()).slice(-7);
const phone = (n: number): string => `96${runDigits}${n}`.slice(0, 10);

beforeAll(async () => {
  await registry.warmup();
  ZIP = await buildZip(day);
  app = createApp();
  adminToken = await signIn(app, 'admin@ipropy.com');
  adminId = (await db.queryOne<{ id: string }>(`SELECT id FROM ipy_user WHERE email = 'admin@ipropy.com'`))!.id;
  await db.query(`DELETE FROM ipy_market_post WHERE body ILIKE '%itestimp%' OR body ILIKE '%zipmark%'`);
  await db.query(`DELETE FROM ipy_market_group WHERE name LIKE 'ITESTIMP%' OR name LIKE 'ZIPMARK%'`);
  await db.query(`DELETE FROM ipy_market_import WHERE group_name LIKE 'ITESTIMP%' OR group_name LIKE 'ZIPMARK%'`);

  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    const sent = JSON.parse(init.body) as { state: string };
    if (sent.state.startsWith('REQUIREMENT:')) {
      // Jev says no to anything that mentions the word "kothi" on the offer side.
      const offer = sent.state.split('OFFER:')[1] ?? '';
      return new Response(JSON.stringify({ answers: { fit: { noul: /kothi/i.test(offer) ? 0.1 : 0.9 } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ answers: { kind: { choice: /required/i.test(sent.state) ? 'lead' : 'inventory', confidence: 0.99 } } }), { status: 200 });
  }));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await db.query(`DELETE FROM ipy_market_post WHERE body ILIKE '%itestimp%' OR body ILIKE '%zipmark%'`);
});

const waitForImports = async (groups: string[]): Promise<Array<{ groupName: string; status: string; newDeals: number; error: string | null }>> => {
  for (let i = 0; i < 80; i += 1) {
    const res = await request(app).get('/api/market/imports').set('Authorization', `Bearer ${adminToken}`);
    const mine = (res.body.imports as Array<{ groupName: string; status: string; newDeals: number; error: string | null }>).filter((row) => groups.includes(row.groupName));
    if (mine.length >= groups.length && mine.every((row) => !['queued', 'running'].includes(row.status))) return mine;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('imports did not finish');
};

describe('dropping many files at once', () => {
  it('names each chat from its file, reads them in the background, and knows a file it has read', async () => {
    const dropped = await request(app).post('/api/market/import-files').set('Authorization', `Bearer ${adminToken}`)
      .attach('files', ZIP, 'WhatsApp Chat - ZIPMARK Gamma.zip');
    expect(dropped.status).toBe(202);
    expect(dropped.body.imports.map((row: { groupName: string }) => row.groupName).sort()).toEqual(['ZIPMARK Alpha Dealers', 'ZIPMARK Beta Dealers']);

    const done = await waitForImports(['ZIPMARK Alpha Dealers', 'ZIPMARK Beta Dealers']);
    expect(done.every((row) => row.status === 'done')).toBe(true);
    expect(done.find((row) => row.groupName === 'ZIPMARK Alpha Dealers')!.newDeals).toBe(2);

    // Dropping the very same file again does nothing and says so.
    const again = await request(app).post('/api/market/import-files').set('Authorization', `Bearer ${adminToken}`)
      .attach('files', ZIP, 'WhatsApp Chat - ZIPMARK Gamma.zip');
    expect(again.body.imports.every((row: { status: string }) => row.status === 'duplicate')).toBe(true);
  });

  it('refuses a drop with no files, and a file that is not a chat', async () => {
    const none = await request(app).post('/api/market/import-files').set('Authorization', `Bearer ${adminToken}`);
    expect(none.status).toBe(400);
    const junk = await request(app).post('/api/market/import-files').set('Authorization', `Bearer ${adminToken}`)
      .attach('files', Buffer.from('   '), 'WhatsApp Chat with ITESTIMP Blank.txt');
    expect(junk.body.imports[0]).toMatchObject({ status: 'failed' });
  });
});

describe('reading only what is new', () => {
  it('the second export of a group costs only what was added since the first', async () => {
    const first = [
      `${day}, 9:00 am - A One: Available 250 gaj plot Sector 71 ${marker} demand 3 cr call ${phone(1)}`,
      `${day}, 9:30 am - A One: 3 BHK flat available Sector 72 ${marker} 1.1 cr call ${phone(1)}`,
    ].join('\n');
    const one = await importGroupExport('ITESTIMP Incremental', first, adminId);
    expect(one).toMatchObject({ newDeals: 2, skippedOld: 0 });

    // The whole history again, plus one new message: only the new one (and the one at the mark) is read.
    const second = `${first}\n${day}, 11:00 am - B Two: Required 300 gaj plot Sector 73 ${marker} budget 4 cr call ${phone(2)}`;
    const two = await importGroupExport('ITESTIMP Incremental', second, adminId);
    // The first message is older than the mark and skipped; the second sits on the mark and is read again, harmlessly.
    expect(two).toMatchObject({ deals: 2, newDeals: 1, repeats: 0, skippedOld: 1 });

    const mark = await db.queryOne<{ read_up_to: Date }>(`SELECT read_up_to FROM ipy_market_group WHERE name = 'ITESTIMP Incremental'`);
    expect(mark?.read_up_to).not.toBeNull();

    const counts = await db.queryOne<{ n: number }>(`SELECT max(seen_count)::int AS n FROM ipy_market_post WHERE body ILIKE '%${marker}%'`);
    expect(counts?.n).toBe(1);
  });

  it('a group renamed with extra spaces is the same group', async () => {
    const out = await importGroupExport('  ITESTIMP   Incremental ', `${day}, 9:00 am - A One: Available 250 gaj plot Sector 71 ${marker} demand 3 cr call ${phone(1)}`, adminId);
    expect(out.skippedOld).toBeGreaterThanOrEqual(0);
    const groups = await db.queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM ipy_market_group WHERE name ILIKE 'ITESTIMP%Incremental%'`);
    expect(groups?.n).toBe(1);
  });
});

describe('a broker\'s long message is many properties, each matched on its own', () => {
  const list = [
    'AVAILABLE FOR SALE | HUDA PLOTS',
    '📍 SECTOR 74', '160 Sq. Yds | North Facing', '💰 ₹3.25 Cr',
    '📍 SECTOR 75', '350 Sq. Yds | South Facing', '💰 ₹6.50 Cr',
    '📍 SECTOR 76', '250 Sq. Yds | West Facing', '💰 ₹4.50 Cr',
    '📞 call', `itestmatch ${marker}`,
  ].join('\n');

  it('a buyer for sector 75 meets the 75 plot, not the first plot of the list', async () => {
    const seller = phone(7);
    const buyer = phone(8);
    await importGroupExport('ITESTIMP Brokers', `${day}, 9:00 am - Broker Seven: ${list}\n${seller}`, adminId);
    await importGroupExport('ITESTIMP Buyers', `${day}, 9:10 am - Buyer Eight: Required 350 gaj plot Sector 75 ${marker} budget 7 cr call ${buyer}`, adminId);

    const listings = await db.query<{ place_keys: string[]; size_sqyd: number }>(
      `SELECT l.place_keys, l.size_sqyd FROM ipy_market_listing l JOIN ipy_market_post p ON p.id = l.post_id WHERE p.poster_phone = $1 ORDER BY l.ord`, [seller]);
    expect(listings.rows.map((r) => [r.place_keys[0], r.size_sqyd])).toEqual([['sector 74', 160], ['sector 75', 350], ['sector 76', 250]]);

    const match = (await findCrossMatches({ limit: 500 })).find((m) => m.want.posterPhone === buyer);
    expect(match?.have.placeKeys).toEqual(['sector 75']);
    expect(match?.have.sizeSqYd).toBe(350);
    // What the card shows is that plot's own lines; the whole broadcast is in .body for the popup.
    expect(match?.have.summary).toContain('350 Sq. Yds');
    expect(match?.have.summary).not.toContain('160 Sq. Yds');
    expect(match?.have.body).toContain('SECTOR 76');
  });

  it('Jev double-checks a pairing once, and a no takes it off the list; "not a real match" never comes back', async () => {
    const buyer = phone(8);
    expect(await verifyPairs(500)).toBeGreaterThanOrEqual(1);
    const checked = (await findCrossMatches({ limit: 500 })).find((m) => m.want.posterPhone === buyer);
    expect(checked?.jevFit).toBeCloseTo(0.9, 1);
    // Asked once: a second pass has nothing new to ask about this pair.
    const before = await db.queryOne<{ n: number }>('SELECT count(*)::int AS n FROM ipy_market_pair_check');
    await verifyPairs(500);
    const after = await db.queryOne<{ n: number }>('SELECT count(*)::int AS n FROM ipy_market_pair_check');
    expect(after?.n).toBe(before?.n);

    await recordOutcome(checked!.want.id, checked!.have.id, 'bad_match', 'wrong plot', adminId);
    expect((await findCrossMatches({ limit: 500, includeWorked: true })).find((m) => m.want.posterPhone === buyer)).toBeUndefined();
  });

  it('a kothi offered to somebody Jev says it does not suit is left off the call sheet', async () => {
    const seller = phone(5);
    const buyer = phone(6);
    await importGroupExport('ITESTIMP Brokers', `${day}, 10:00 am - Broker Five: 500 gaj kothi for sale Sector 77 ${marker} 12 cr call ${seller}`, adminId);
    await importGroupExport('ITESTIMP Buyers', `${day}, 10:10 am - Buyer Six: Required 500 gaj plot kothi Sector 77 ${marker} budget 13 cr call ${buyer}`, adminId);
    expect((await findCrossMatches({ limit: 500 })).find((m) => m.want.posterPhone === buyer)).toBeDefined();
    await verifyPairs(500);
    expect((await findCrossMatches({ limit: 500 })).find((m) => m.want.posterPhone === buyer)).toBeUndefined();
  });
});

describe('opening a message in full', () => {
  it('gives the whole message, the properties in it and every sighting', async () => {
    const row = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_market_post WHERE body ILIKE '%SECTOR 76%' AND body ILIKE '%${marker}%' LIMIT 1`);
    const res = await request(app).get(`/api/market/posts/${row!.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.post.body).toContain('SECTOR 76');
    expect(res.body.listings).toHaveLength(3);
    expect(res.body.sightings[0].group).toBe('ITESTIMP Brokers');
    const missing = await request(app).get('/api/market/posts/00000000-0000-4000-8000-000000000000').set('Authorization', `Bearer ${adminToken}`);
    expect(missing.status).toBe(404);
  });
});

describe('a visit of the background worker', () => {
  it('gets to Jev\'s check of a new pairing — the slow AI stage is last and cannot hold it up', async () => {
    const seller = phone(3);
    const buyer = phone(4);
    await importGroupExport('ITESTIMP Brokers', `${day}, 11:00 am - Broker Three: 400 gaj plot for sale Sector 78 ${marker} 6 cr call ${seller}`, adminId);
    await importGroupExport('ITESTIMP Buyers', `${day}, 11:10 am - Buyer Four: Required 400 gaj plot Sector 78 ${marker} budget 7 cr call ${buyer}`, adminId);
    const found = async () => (await findCrossMatches({ limit: 500 })).find((m) => m.want.posterPhone === buyer);
    // An upload also starts a visit, so this one may find the worker busy; either way the pairing gets checked.
    void marketWork();
    for (let i = 0; i < 100 && (await found())?.jevFit == null; i += 1) await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await found())?.jevFit).toBeCloseTo(0.9, 1);
  });
});
