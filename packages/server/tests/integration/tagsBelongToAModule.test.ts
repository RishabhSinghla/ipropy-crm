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
const NAMES = ['itest_everywhere', 'itest_leads_only', 'itest_props_only', 'itest_both'];

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
    expect((await list()).map((t) => t.name).sort()).toEqual([...NAMES].sort());
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
});
