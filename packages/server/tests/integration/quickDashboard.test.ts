import { afterAll, beforeAll, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { adminContext, leadInput, signIn, SEEDED } from './fixtures.js';

const app = createApp();
const marker = `QuickGraphic${Date.now()}`;
let token: string;
let id: string;
beforeAll(async () => {
  const ctx = await adminContext(); token = await signIn(app, ctx.user.email);
  const record = await recordService.createRecord(ctx, 'leads', leadInput({ full_name: marker })); id = record.id;
  await db.query('INSERT INTO ipy_comment(record_id,user_id,body) VALUES($1,$2,$3)', [id, ctx.user.id, `${marker}NoteOnly`]);
});
afterAll(async () => {
  await db.query('DELETE FROM ipy_record WHERE id=$1', [id]);
  await db.query('DELETE FROM ipy_tag WHERE name LIKE $1', [`${marker.toLowerCase()}%`]);
});

it('returns five charts matching the current search and handles overlapping tags', async () => {
  await request(app).post(`/api/records/leads/${id}/tags`).set('Authorization', `Bearer ${token}`).send({ tags: [`${marker}A`, `${marker}B`] }).expect(200);
  const result = await request(app).post('/api/records/leads/quick-dashboard').set('Authorization', `Bearer ${token}`).send({ search: `${marker}NoteOnly` }).expect(200);
  expect(result.body.total).toBe(1);
  expect(result.body.createdToday).toBe(1);
  expect(result.body.tagged).toBe(1);
  expect(result.body.charts).toHaveLength(5);
  for (const chart of result.body.charts.filter((c: { title: string; unavailable: boolean }) => c.title !== 'Tags' && !c.unavailable)) {
    expect(chart.slices.reduce((sum: number, slice: { count: number }) => sum + slice.count, 0)).toBe(1);
  }
  expect(result.body.charts.find((c: { title: string }) => c.title === 'Tags').slices).toHaveLength(2);
});

it('excludes another agent’s private record and returns a stable zero state', async () => {
  const other = await signIn(app, SEEDED.executiveA);
  const result = await request(app).post('/api/records/leads/quick-dashboard').set('Authorization', `Bearer ${other}`).send({ search: marker }).expect(200);
  expect(result.body.total).toBe(0);
  expect(result.body.charts.every((c: { slices: unknown[] }) => c.slices.length === 0)).toBe(true);
});

it('honours date and changed-agent criteria without changing the underlying list', async () => {
  const result = await request(app).post('/api/records/leads/quick-dashboard').set('Authorization', `Bearer ${token}`).send({ search: marker, filter: { logic: 'AND', conditions: [{ field: 'created_at', operator: 'yesterday' }] } }).expect(200);
  expect(result.body.total).toBe(0);
  const again = await request(app).post('/api/records/leads/quick-dashboard').set('Authorization', `Bearer ${token}`).send({ search: marker }).expect(200);
  expect(again.body.total).toBe(1);
});
