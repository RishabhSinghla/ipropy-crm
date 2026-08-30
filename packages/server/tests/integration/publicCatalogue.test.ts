/**
 * The catalogue the public website reads.
 *
 * Everything here is about one class of failure: the endpoint answers 200 with
 * an empty list, which is indistinguishable from genuinely having no stock. No
 * error is logged, nothing turns red, and the website simply shows nothing.
 *
 * That is not hypothetical. The properties list compared the status column to
 * the *array* of published statuses with `=` instead of `= ANY`, so it matched
 * nothing at all and had been returning zero for as long as it had existed,
 * while every other query in the same file used `= ANY`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { adminContext } from './fixtures.js';
import type { ServiceContext } from '../../src/core/entity/recordService.js';

let app: Express;
let ctx: ServiceContext;
const made: string[] = [];

/**
 * A property that somebody actually chose to publish.
 *
 * `publish_to_web` is explicit here because publishing is now a decision rather
 * than a default — an unset flag means hidden. That change broke four of the
 * tests below, which is exactly what should have happened: they were all
 * relying on a property reaching the public website without anybody saying so.
 */
async function publish(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const rec = await recordService.createRecord(ctx, 'properties', {
    name,
    status: 'Available',
    project_name: 'Catalogue Test Project',
    city: 'Faridabad',
    publish_to_web: true,
    ...extra,
  });
  made.push(rec.id);
  return rec.id;
}

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  ctx = await adminContext();
});

afterAll(async () => {
  if (made.length) {
    await db.query(`DELETE FROM ipy_record WHERE id = ANY($1::uuid[])`, [made]);
  }
});

describe('the public property list', () => {
  it('returns a property whose status is published', async () => {
    const name = `Catalogue ${Date.now()}`;
    await publish(name);

    const res = await request(app).get('/api/public/properties?limit=50');
    expect(res.status).toBe(200);

    // The assertion that would have caught the `=` vs `= ANY` bug: the list is
    // not merely well-formed, it actually contains the thing we just published.
    const names = (res.body.items as { name: string }[]).map((i) => i.name);
    expect(names).toContain(name);
    expect(res.body.total).toBeGreaterThan(0);
  });

  it('hides a property whose status is not published', async () => {
    const name = `Hidden ${Date.now()}`;
    const id = await publish(name);
    await db.query(`UPDATE ipy_e_properties SET status = 'Booked' WHERE record_id = $1`, [id]);

    const res = await request(app).get('/api/public/properties?limit=50');
    const names = (res.body.items as { name: string }[]).map((i) => i.name);
    expect(names).not.toContain(name);
  });

  it('hides a property the admin has switched off for the website', async () => {
    const name = `Unpublished ${Date.now()}`;
    const id = await publish(name);
    await db.query(
      `UPDATE ipy_e_properties
          SET custom_fields = COALESCE(custom_fields, '{}'::jsonb) || '{"publish_to_web":"false"}'::jsonb
        WHERE record_id = $1`,
      [id],
    );

    const res = await request(app).get('/api/public/properties?limit=50');
    const names = (res.body.items as { name: string }[]).map((i) => i.name);
    expect(names).not.toContain(name);
  });

  it('shows the photographs that are on the record', async () => {
    // The last broken link between a site visit and the website.
    //
    // n8n uploads the finished copies to the record as attachments. The CRM's
    // own screens read attachments. But the public API read a separate `gallery`
    // column that nothing in the codebase has ever written — so a property could
    // be shot, processed, published, look perfect inside the CRM, and appear on
    // the website with no pictures at all. Two lists of the same thing, one of
    // them never filled.
    const name = `Gallery ${Date.now()}`;
    const id = await publish(name);

    const before = await request(app).get('/api/public/properties?limit=50');
    const beforeItem = (before.body.items as { name: string; gallery: string[] }[]).find((i) => i.name === name);
    expect(beforeItem?.gallery).toEqual([]);

    // Attach two images the way an upload does, in a deliberate order.
    for (const [i, file] of ['second.jpg', 'first.jpg'].entries()) {
      await db.query(
        `INSERT INTO ipy_attachment (record_id, file_name, mime_type, size, storage_key, sort_order, uploaded_by)
         VALUES ($1, $2, 'image/jpeg', 1234, $3, $4,
                 (SELECT id FROM ipy_user WHERE is_admin = true ORDER BY created_at LIMIT 1))`,
        [id, file, `test/${Date.now()}-${file}`, i === 0 ? 2 : 1],
      );
    }

    const after = await request(app).get('/api/public/properties?limit=50');
    const item = (after.body.items as { name: string; gallery: string[] }[]).find((i) => i.name === name);
    expect(item?.gallery).toHaveLength(2);

    // And in the order the team set, because the cover photo leads the listing.
    expect(item!.gallery[0]).toContain('/api/public/media/');
    const ordered = await db.query<{ file_name: string }>(
      `SELECT file_name FROM ipy_attachment WHERE record_id = $1 ORDER BY sort_order NULLS LAST, created_at`,
      [id],
    );
    expect(ordered.rows.map((r) => r.file_name)).toEqual(['first.jpg', 'second.jpg']);
  });

  it('still filters by city without losing everything', async () => {
    // A filter that silently matched nothing would look the same as "no stock
    // in that city", which is the whole failure mode this file is about.
    const name = `City Filter ${Date.now()}`;
    await publish(name);

    const res = await request(app).get('/api/public/properties?city=Faridabad&limit=50');
    expect(res.status).toBe(200);
    const names = (res.body.items as { name: string }[]).map((i) => i.name);
    expect(names).toContain(name);
  });
});

/**
 * Every other endpoint that reads the published-status list.
 *
 * The file above was written after `/properties` was found comparing the status
 * column to the *array* of published statuses with `=`. Two endpoints were
 * fixed then and `/cities` was missed, so the website's "Where we work" section
 * had been empty since it was built and nothing said so.
 *
 * The lesson is that testing the endpoint that broke is not enough. Anything
 * that takes `publicPropertyStatuses()` shares the mistake, so each one needs an
 * assertion that it comes back holding the thing that was just published.
 */
describe('every public endpoint that reads the published statuses', () => {
  it('lists the city a published property is in', async () => {
    await publish(`City Roll-up ${Date.now()}`);

    const res = await request(app).get('/api/public/cities');
    expect(res.status).toBe(200);

    const cities = res.body.items as { city: string; project_count: number; unit_count: number }[];
    const faridabad = cities.find((c) => c.city === 'Faridabad');
    expect(faridabad).toBeDefined();
    expect(faridabad!.unit_count).toBeGreaterThan(0);
    expect(faridabad!.project_count).toBeGreaterThan(0);
  });

  it('lists the project a published property belongs to', async () => {
    await publish(`Project Roll-up ${Date.now()}`);

    const res = await request(app).get('/api/public/projects');
    expect(res.status).toBe(200);
    const names = (res.body.items as { name: string }[]).map((i) => i.name);
    expect(names).toContain('Catalogue Test Project');
  });

  it('opens a project page with its units on it', async () => {
    const name = `Project Detail ${Date.now()}`;
    await publish(name);

    const list = await request(app).get('/api/public/projects');
    // A project has no record of its own. Its `id` is its name slugified, which
    // is what the detail route matches on.
    const project = (list.body.items as { name: string; id: string }[])
      .find((i) => i.name === 'Catalogue Test Project');
    expect(project).toBeDefined();

    // `similar` runs a second query with its own parameter numbering, which is
    // the kind of thing that breaks quietly when a condition is made optional.
    const res = await request(app).get(`/api/public/projects/${project!.id}`);
    expect(res.status).toBe(200);
    const units = (res.body.units as { name: string }[]).map((u) => u.name);
    expect(units).toContain(name);
    expect(Array.isArray(res.body.similar)).toBe(true);
  });

  it('does not count a property the admin has switched off for the website', async () => {
    // The mirror of the tests above. An endpoint that returned everything
    // regardless would also pass "it is not empty", so both directions matter.
    const before = await request(app).get('/api/public/cities');
    const countBefore = (before.body.items as { city: string; unit_count: number }[])
      .find((c) => c.city === 'Faridabad')?.unit_count ?? 0;

    const id = await publish(`Hidden From Cities ${Date.now()}`);
    await db.query(
      `UPDATE ipy_e_properties
          SET custom_fields = COALESCE(custom_fields, '{}'::jsonb) || '{"publish_to_web":"false"}'::jsonb
        WHERE record_id = $1`,
      [id],
    );

    const after = await request(app).get('/api/public/cities');
    const countAfter = (after.body.items as { city: string; unit_count: number }[])
      .find((c) => c.city === 'Faridabad')?.unit_count ?? 0;
    expect(countAfter).toBe(countBefore);
  });

  it('does not publish a property nobody chose to publish', async () => {
    /*
      The rule that changed, and the one worth guarding hardest.

      `publishClause` used to read `IS NULL OR = 'true'`, and the key is unset on
      every newly created record until somebody explicitly saves that field. So a
      property went to the public website the moment it was created — before it
      had photographs, a price or a verified address. Both properties on the live
      site show "Price on request" for exactly this reason.

      Reaching the website is a decision now. An unset flag means hidden.
    */
    const id = await publish(`Never Chosen ${Date.now()}`);
    await db.query(
      `UPDATE ipy_e_properties
          SET custom_fields = COALESCE(custom_fields, '{}'::jsonb) - 'publish_to_web'
        WHERE record_id = $1`,
      [id],
    );

    const listed = await request(app).get('/api/public/properties');
    const ids = (listed.body.items as { id: string }[]).map((u) => u.id);
    expect(ids, 'an unset flag must not publish').not.toContain(id);

    // And it is genuinely reachable once somebody says yes, so this is a
    // default and not a wall.
    await db.query(
      `UPDATE ipy_e_properties
          SET custom_fields = COALESCE(custom_fields, '{}'::jsonb) || '{"publish_to_web":"true"}'::jsonb
        WHERE record_id = $1`,
      [id],
    );
    const after = await request(app).get('/api/public/properties');
    expect((after.body.items as { id: string }[]).map((u) => u.id)).toContain(id);
  });

  it('starts a new property with publishing switched off', async () => {
    // The other half: the field's own default, which is what the create form
    // seeds. A default of true here would put the record back on the website
    // whatever the clause says.
    const field = await db.queryOne<{ default_value: unknown }>(
      `SELECT default_value FROM ipy_field
        WHERE name = 'publish_to_web'
          AND module_id IN (SELECT id FROM ipy_module WHERE name = 'properties')`,
    );
    expect(String(field?.default_value)).toBe('false');
  });
});
