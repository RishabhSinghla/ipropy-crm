import { afterAll, beforeAll, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { adminContext, contextFor, leadInput, SEEDED, signIn } from './fixtures.js';

const marker = `SearchNotesTags${Date.now()}`;
const made: string[] = [];
let ctx: Awaited<ReturnType<typeof adminContext>>;
let token: string;
const app = createApp();
beforeAll(async () => { await registry.warmup(); ctx = await adminContext(); token = await signIn(app, ctx.user.email); });
afterAll(async () => { await db.query('DELETE FROM ipy_record WHERE id = ANY($1::uuid[])', [made]); await db.query('DELETE FROM ipy_tag WHERE name LIKE $1', [`${marker.toLowerCase()}%`]); });

it('finds a record by its note in global search and the matching list', async () => {
  const record = await recordService.createRecord(ctx, 'leads', leadInput()); made.push(record.id);
  await db.query('INSERT INTO ipy_comment(record_id,user_id,body) VALUES($1,$2,$3)', [record.id, ctx.user.id, marker]);
  expect((await recordService.globalSearch(ctx, marker)).some(hit => hit.id === record.id)).toBe(true);
  expect((await recordService.listRecords(ctx, 'leads', { search: marker })).rows.map(r => r.id)).toContain(record.id);
  const other = await contextFor(SEEDED.executiveA);
  // A note on an inaccessible record must not leak via the name-only fallback.
  expect((await recordService.globalSearch(other, marker)).some(hit => hit.id === record.id)).toBe(false);
});

it('adds bulk tags without replacing earlier tags, logs changes and is idempotent', async () => {
  const record = await recordService.createRecord(ctx, 'leads', leadInput()); made.push(record.id);
  const old = `${marker}_old`.toLowerCase(), added = `${marker}_new`.toLowerCase();
  await request(app).post(`/api/records/leads/${record.id}/tags`).set('Authorization', `Bearer ${token}`).send({ tags: [old] }).expect(200);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await request(app).post('/api/records/leads/mass-tags').set('Authorization', `Bearer ${token}`).send({ ids: [record.id], tags: [added] }).expect(200);
    expect(response.body.updated).toBe(1); expect(response.body.failed).toEqual([]);
  }
  const tags = await db.query<{ name: string }>('SELECT t.name FROM ipy_tag t JOIN ipy_tag_link l ON l.tag_id=t.id WHERE l.record_id=$1', [record.id]);
  expect(tags.rows.map(t => t.name).sort()).toEqual([old, added].sort());
  const audit = await db.query('SELECT id FROM ipy_audit WHERE record_id=$1 AND changes::text LIKE $2', [record.id, '%record_tags%']);
  expect(audit.rows.length).toBeGreaterThan(0);
});

it('supports filtered bulk tags and reports wrong-module records unchanged', async () => {
  const record = await recordService.createRecord(ctx, 'leads', leadInput({ full_name: `${marker}Filtered` })); made.push(record.id);
  const response = await request(app).post('/api/records/leads/mass-tags').set('Authorization', `Bearer ${token}`).send({ query: { search: `${marker}Filtered` }, tags: [`${marker}_query`] }).expect(200);
  expect(response.body.updated).toBe(1);
  const wrong = await request(app).post('/api/records/properties/mass-tags').set('Authorization', `Bearer ${token}`).send({ ids: [record.id], tags: [`${marker}_wrong`] }).expect(200);
  expect(wrong.body.updated).toBe(0); expect(wrong.body.failed).toHaveLength(1);
});

it('probes normalized mobile immediately, shows owner and excludes the edited record', async () => {
  const input = leadInput(), record = await recordService.createRecord(ctx, 'leads', input); made.push(record.id);
  const hits = await recordService.findMobileDuplicates(ctx, 'properties', { mobile: `+91 ${input.mobile}` });
  expect(hits).toContainEqual(expect.objectContaining({ id: record.id, module: 'leads', ownerName: ctx.user.fullName, matchedOn: ['mobile'] }));
  expect(await recordService.findMobileDuplicates(ctx, 'leads', { mobile: input.mobile }, record.id)).toEqual([]);
  expect(await recordService.findMobileDuplicates(ctx, 'leads', { mobile: '123' })).toEqual([]);
});
