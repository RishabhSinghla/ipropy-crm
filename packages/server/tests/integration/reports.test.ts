/**
 * A saved report is a saved question, answered as whoever asks it.
 *
 * The parts worth a real database are the ones a unit test cannot see: that
 * running one goes through the permission-scoped engine rather than a second
 * query path, that a shared report gives two people two different answers
 * because they can see different records, and that the export is the numbers
 * on screen rather than the records behind them.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { signIn, SEEDED } from './fixtures.js';

let app: Express;
let adminToken = '';
let repToken = '';

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  adminToken = await signIn(app, 'admin@ipropy.com');
  repToken = await signIn(app, SEEDED.executiveA);
  await db.query(`DELETE FROM ipy_report WHERE name LIKE 'itest %'`);
});

const config = { module: 'leads', aggregate: 'count', groupBy: 'status', limit: 15 };

describe('reports', () => {
  it('answers a question without saving it first', async () => {
    const res = await request(app).post('/api/reports/run')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ type: 'bar', config })
      .expect(200);

    expect(Array.isArray(res.body.series)).toBe(true);
    // Every group carries a label a person can read, not a stored value: the
    // two have drifted on this database before and the report would print
    // whichever the database happened to hold.
    for (const point of res.body.series) expect(typeof point.label).toBe('string');
  });

  it('saves, lists, shares and deletes one', async () => {
    const created = await request(app).post('/api/reports')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'itest by status', module: 'leads', type: 'bar', config })
      .expect(201);
    const id = created.body.id as string;
    expect(created.body.isShared).toBe(false);

    const mine = await request(app).get('/api/reports')
      .set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(mine.body.some((r: { id: string }) => r.id === id)).toBe(true);

    // Not yet shared, so it is nobody else's business.
    const theirs = await request(app).get('/api/reports')
      .set('Authorization', `Bearer ${repToken}`).expect(200);
    expect(theirs.body.some((r: { id: string }) => r.id === id)).toBe(false);

    await request(app).patch(`/api/reports/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isShared: true }).expect(200);

    const shared = await request(app).get('/api/reports')
      .set('Authorization', `Bearer ${repToken}`).expect(200);
    expect(shared.body.some((r: { id: string }) => r.id === id)).toBe(true);

    // Somebody else's report is theirs to change, not everybody's.
    await request(app).patch(`/api/reports/${id}`)
      .set('Authorization', `Bearer ${repToken}`)
      .send({ name: 'itest renamed by a rep' }).expect(403);

    await request(app).delete(`/api/reports/${id}`)
      .set('Authorization', `Bearer ${adminToken}`).expect(200);
    const gone = await request(app).get('/api/reports')
      .set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(gone.body.some((r: { id: string }) => r.id === id)).toBe(false);
  });

  it('gives the same shared question two answers, one per person', async () => {
    /*
      The reason nothing is cached. An admin sees every contact; an executive
      sees their own and their team's. One stored number would be whichever of
      the two ran last, handed to both.
    */
    const total = (token: string): Promise<number> => request(app).post('/api/reports/run')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'metric', config: { module: 'leads', aggregate: 'count' } })
      .expect(200)
      .then((res) => Number(res.body.value ?? 0));

    expect(await total(adminToken)).toBeGreaterThan(await total(repToken));
  });

  it('exports the answer, not the records behind it', async () => {
    const res = await request(app).post('/api/reports/export')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ type: 'bar', config, title: 'itest export' })
      .expect(200);

    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const lines = String(res.text).trim().split('\n');
    expect(lines[0]).toContain('Group');
    // One line per group, not one per contact.
    expect(lines.length).toBeLessThan(30);
    // And a value that would run as a formula is neutralised before somebody
    // opens the file in Excel.
    expect(res.text.includes('\n"=')).toBe(false);
  });

  it('refuses a module nobody may read', async () => {
    await request(app).post('/api/reports')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'itest nonsense', module: 'no_such_module', type: 'bar', config })
      .expect(404);
  });
});
