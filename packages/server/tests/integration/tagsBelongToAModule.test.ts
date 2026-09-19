/**
 * A tag offered on the wrong module is a filter that can only find nothing.
 *
 * `ipy_tag` was one shared vocabulary: every tag offered on every record of
 * every module. The owner asked for the two lists to be separate — "Site Visit
 * Done" means nothing on a builder floor and "Corner Unit" means nothing on a
 * person — while still allowing a tag that genuinely belongs to both.
 *
 * The half worth pinning against a real database is the *default*. `modules`
 * is an empty array for every tag that predates the column, and empty means
 * "offer me everywhere". Read that as "belongs to nothing" and 25,560 tagged
 * properties quietly lose their tags from every picker, with no error anywhere
 * — which is exactly the shape of failure this codebase keeps meeting.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { signIn } from './fixtures.js';

let app: Express;
let token = '';
const NAMES = ['itest_everywhere', 'itest_leads_only', 'itest_props_only', 'itest_both', 'itest_counted'];

const counted = async (module?: string): Promise<number> => {
  const res = await request(app)
    .get(`/api/tags${module ? `?module=${module}` : ''}`)
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  return (res.body as { name: string; usage_count: number }[])
    .find((t) => t.name === 'itest_counted')?.usage_count ?? -1;
};

const list = async (module?: string): Promise<{ name: string; modules: string[] }[]> => {
  const res = await request(app)
    .get(`/api/tags${module ? `?module=${module}` : ''}`)
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  return (res.body as { name: string; modules: string[] }[]).filter((t) => NAMES.includes(t.name));
};

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  const admin = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`);
  token = await signIn(app, admin!.email);
  await db.query(`DELETE FROM ipy_tag WHERE name = ANY($1::text[])`, [NAMES]);
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_record WHERE label LIKE 'itest_count_%'`);
  await db.query(`DELETE FROM ipy_tag WHERE name = ANY($1::text[])`, [NAMES]);
});

describe('which module a tag belongs to', () => {
  it('offers a tag everywhere when no module is named', async () => {
    // The migration's default, and what every existing tag carries.
    await request(app).post('/api/tags').set('Authorization', `Bearer ${token}`)
      .send({ name: 'itest_everywhere' }).expect(201);

    for (const module of ['leads', 'properties']) {
      expect((await list(module)).map((t) => t.name)).toContain('itest_everywhere');
    }
  });

  it('keeps a narrowed tag out of the other module', async () => {
    await request(app).post('/api/tags').set('Authorization', `Bearer ${token}`)
      .send({ name: 'itest_leads_only', modules: ['leads'] }).expect(201);
    await request(app).post('/api/tags').set('Authorization', `Bearer ${token}`)
      .send({ name: 'itest_props_only', modules: ['properties'] }).expect(201);

    expect((await list('leads')).map((t) => t.name)).toContain('itest_leads_only');
    expect((await list('leads')).map((t) => t.name)).not.toContain('itest_props_only');
    expect((await list('properties')).map((t) => t.name)).toContain('itest_props_only');
    expect((await list('properties')).map((t) => t.name)).not.toContain('itest_leads_only');
  });

  it('offers a tag named for both on both', async () => {
    await request(app).post('/api/tags').set('Authorization', `Bearer ${token}`)
      .send({ name: 'itest_both', modules: ['leads', 'properties'] }).expect(201);

    expect((await list('leads')).map((t) => t.name)).toContain('itest_both');
    expect((await list('properties')).map((t) => t.name)).toContain('itest_both');
  });

  it('gives the admin screen the whole vocabulary, narrowed or not', async () => {
    // No `?module=`: every tag, including ones scoped to a module this screen
    // is not looking at. Otherwise a tag narrowed to Inventories could never
    // be found again to widen it.
    // The four this file has created by now; the counting test below adds a
    // fifth afterwards.
    expect((await list()).map((t) => t.name).sort())
      .toEqual(['itest_both', 'itest_everywhere', 'itest_leads_only', 'itest_props_only']);
  });

  it('widens a tag back to everywhere when the admin clears every module', async () => {
    /*
      The one that needs saying out loud. Clearing every checkbox is an answer —
      "offer this everywhere" — and an update that treats an empty array as "no
      answer given" silently ignores the admin and leaves the tag narrowed.
    */
    const id = (await db.queryOne<{ id: string }>(
      `SELECT id FROM ipy_tag WHERE name = 'itest_leads_only'`))!.id;

    await request(app).patch(`/api/tags/${id}`).set('Authorization', `Bearer ${token}`)
      .send({ modules: [] }).expect(200);

    expect((await list('properties')).map((t) => t.name)).toContain('itest_leads_only');
  });

  it('counts records the list would show, not links', async () => {
    /*
      The number beside a tag is the only thing on that row a rep reads, and it
      read 229 on production beside a tag whose list says 2. It counted rows in
      `ipy_tag_link`, which survives both things that take a record off the
      list: a delete only flags the row, and a tag offered on both modules
      carries links to the other one.

      The records are inserted straight into `ipy_record` — the count joins
      nothing else, and a payload row would only make the fixture slower to
      build and to clean up.
    */
    await request(app).post('/api/tags').set('Authorization', `Bearer ${token}`)
      .send({ name: 'itest_counted' }).expect(201);
    const tag = (await db.queryOne<{ id: string }>(
      `SELECT id FROM ipy_tag WHERE name = 'itest_counted'`))!.id;

    for (const [module, label, deleted] of [
      ['leads', 'itest_count_live_lead', false],
      ['leads', 'itest_count_dead_lead', true],
      ['properties', 'itest_count_live_unit', false],
    ] as [string, string, boolean][]) {
      const row = (await db.queryOne<{ id: string }>(
        `INSERT INTO ipy_record (module_id, module_name, label, is_deleted)
         VALUES ((SELECT id FROM ipy_module WHERE name = $1), $1, $2, $3) RETURNING id`,
        [module, label, deleted],
      ))!;
      await db.query(`INSERT INTO ipy_tag_link (tag_id, record_id) VALUES ($1,$2)`, [tag, row.id]);
    }

    expect(await counted('leads'), 'the deleted lead is still being counted').toBe(1);
    expect(await counted('properties'), 'the leads links are being counted here').toBe(1);
    // The admin screen asks for no module at all: every live record, both
    // modules, and still not the deleted one.
    expect(await counted()).toBe(2);
  });

  it('will not put another module\'s tag on a record, and does not show one', async () => {
    /*
      The owner's report, 19 September: *"The sale tag shown in leads module
      even we have not given right to lead module"*. Two halves, and both have
      to hold — the picker offering the right tags is not enough.

      Writing: a tag narrowed elsewhere is refused rather than linked, so an
      old tab, an import or a script cannot put "Corner Unit" on a person.
      Reading: the links already written before the narrowing stay in the
      table and must not reach the screen, since a tag on a module nobody gave
      it to is exactly what was reported.
    */
    const list = await request(app).get('/api/records/leads?pageSize=1')
      .set('Authorization', `Bearer ${token}`).expect(200);
    const leadId = String((list.body as { rows: { id: string }[] }).rows[0].id);

    await request(app).post(`/api/records/leads/${leadId}/tags`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tags: ['itest_props_only'] })
      .expect(400);

    // The same link, written the way history wrote it — straight into the
    // table, before anybody narrowed the tag.
    const tag = (await db.queryOne<{ id: string }>(
      `SELECT id FROM ipy_tag WHERE name = 'itest_props_only'`))!.id;
    await db.query(`INSERT INTO ipy_tag_link (tag_id, record_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [tag, leadId]);

    const record = await request(app).get(`/api/records/leads/${leadId}`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect((record.body as { tags: string[] }).tags).not.toContain('itest_props_only');

    await db.query(`DELETE FROM ipy_tag_link WHERE tag_id = $1`, [tag]);
  });
});
