/**
 * The call sheet as a person uses it: a page at a time with the total beside it, a button that
 * keeps its answer and gives it back when pressed again, two answers that put a pairing away for
 * good, and a matcher that learns from "not a real match". Only a real database proves the SQL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { signIn } from './fixtures.js';
import { loadLessons } from '../../src/core/market/crossMatch.js';

let app: Express;
let token = '';
const marker = `itestsheet${Date.now()}`;
const today = new Date();
const stamp = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;
const COUNT = 14;

type Row = { id: string; status: string; want: { id: string; summary: string }; have: { id: string; posterPhone: string } };
type Sheet = { rows: Row[]; total: number; page: number };
const auth = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${token}`);
const sheet = async (query = ''): Promise<Sheet> => {
  const res = await auth(request(app).get(`/api/market/matches?minScore=0.5${query}`));
  expect(res.status).toBe(200);
  return { rows: res.body as Row[], total: Number(res.headers['x-total-count']), page: Number(res.headers['x-page']) };
};
// Ours only: the rest of the test database holds other suites' pairings.
const mine = (rows: Row[]): Row[] => rows.filter((row) => row.have.posterPhone.startsWith('97') && row.want.summary.includes(marker));

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  token = await signIn(app, 'admin@ipropy.com');
  await db.query(`DELETE FROM ipy_market_post WHERE body ILIKE '%itestsheet%'`);
  const buyers = Array.from({ length: COUNT }, (_, i) => `${stamp}, 10:${String(10 + i).padStart(2, '0')} am - Buyer${i}: Required ${200 + i * 20} gaj plot sector 91 ${marker} budget 9 cr call 98${String(i).padStart(8, '0')}`);
  const sellers = Array.from({ length: COUNT }, (_, i) => `${stamp}, 11:${String(10 + i).padStart(2, '0')} am - Seller${i}: ${200 + i * 20} sq yd residential plot for sale sector 91 ${marker} demand 3 cr call 97${String(i).padStart(8, '0')}`);
  for (const [group, lines] of [[`Buyers ${marker}`, buyers], [`Sellers ${marker}`, sellers]] as const) {
    const res = await auth(request(app).post('/api/market/import')).field('group', group).attach('file', Buffer.from(lines.join('\n')), 'chat.txt');
    expect(res.status).toBe(200);
  }
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_market_post WHERE body ILIKE '%itestsheet%'`);
});

/** Uploading wakes the background readers, which rebuild the kept sheet; wait until it has stopped changing. */
async function settled(): Promise<void> {
  for (let tries = 0; tries < 20; tries += 1) {
    const a = (await sheet('&pageSize=1')).total;
    await new Promise((resolve) => setTimeout(resolve, 400));
    if ((await sheet('&pageSize=1')).total === a) return;
  }
}

describe('the call sheet, a page at a time', () => {
  it('says how many pairings there are in all, and gives each page its own', async () => {
    await settled();
    const first = await sheet('&pageSize=3&page=1&limit=1');
    expect(first.rows).toHaveLength(3);
    // Not every buyer finds a seller of a size that fits, so this is "most of them".
    expect(first.total).toBeGreaterThanOrEqual(COUNT * 0.6);
    expect(first.page).toBe(1);
    const second = await sheet('&pageSize=3&page=2');
    expect(second.rows).toHaveLength(3);
    expect(second.rows.map((r) => r.id).filter((id) => first.rows.some((r) => r.id === id))).toEqual([]);
    expect(second.total).toBe(first.total);
    // The last page is short, and one past it is empty rather than an error.
    const lastPage = Math.ceil(first.total / 3);
    expect((await sheet(`&pageSize=3&page=${lastPage}`)).rows.length).toBe(first.total - (lastPage - 1) * 3);
    expect((await sheet(`&pageSize=3&page=${lastPage + 1}`)).rows).toEqual([]);
  });

  it('keeps an answer in place, and takes it back when the same button is pressed again', async () => {
    const pick = mine((await sheet('&pageSize=100')).rows)[0]!;
    const put = (status: string) => auth(request(app).put(`/api/market/matches/${pick.want.id}/${pick.have.id}`)).send({ status });
    const statusNow = async () => (await sheet('&pageSize=100')).rows.find((r) => r.id === pick.id)?.status;

    expect((await put('called')).status).toBe(200);
    expect(await statusNow()).toBe('called');
    expect((await put('new')).status).toBe(200);
    expect(await statusNow()).toBe('new');
    expect((await put('won')).status).toBe(200);
    expect(await statusNow()).toBe('won');
    // Filtering by status finds it, and "not worked yet" no longer does.
    expect((await sheet('&pageSize=100&status=won')).rows.some((r) => r.id === pick.id)).toBe(true);
    expect((await sheet('&pageSize=100&status=new')).rows.some((r) => r.id === pick.id)).toBe(false);
    await put('new');
  });

  it('puts "not for us" and "not a real match" away for good, and the total follows at once', async () => {
    const before = await sheet('&pageSize=100');
    const [away, wrong] = mine(before.rows);
    expect((await auth(request(app).put(`/api/market/matches/${away!.want.id}/${away!.have.id}`)).send({ status: 'dismissed' })).status).toBe(200);
    expect((await auth(request(app).put(`/api/market/matches/${wrong!.want.id}/${wrong!.have.id}`)).send({ status: 'bad_match' })).status).toBe(200);
    const after = await sheet('&pageSize=100');
    expect(after.rows.some((r) => r.id === away!.id || r.id === wrong!.id)).toBe(false);
    expect(after.total).toBe(before.total - 2);
    // Not on the next look either, nor when finished work is asked for.
    expect((await sheet('&pageSize=100&includeWorked=true')).rows.some((r) => r.id === away!.id || r.id === wrong!.id)).toBe(false);
  });

  it('learns from "not a real match": enough of one kind and the matcher remembers it', async () => {
    const rows = mine((await sheet('&pageSize=100')).rows).slice(0, 3);
    for (const row of rows) {
      await auth(request(app).put(`/api/market/matches/${row.want.id}/${row.have.id}`)).send({ status: 'bad_match' });
    }
    const lessons = await loadLessons();
    const learned = [...lessons.signatures.values()].filter((seen) => seen.bad >= 3);
    expect(learned.length).toBeGreaterThan(0);
    expect(lessons.hidden.size).toBeGreaterThanOrEqual(3);
    expect(lessons.posters.size).toBeGreaterThan(0);
  });
});
