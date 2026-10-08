/**
 * Projects — a developer's project as a record of its own.
 *
 * **8 October 2026, the owner:** *"make me a project module in the CRM wherein we
 * can input all details of all projects we got … DLF, BPTP, Omaxe etc."*
 *
 * A module is seed data and SQL strings: typecheck reads neither, and a mocked
 * `db.query` accepts any statement. So this suite asks a real database the
 * questions the module was built to answer:
 *
 * * **It exists for everybody it should** — the admin creates, a sales executive
 *   reads and cannot create, a telecaller never sees the brokerage.
 * * **A project is unique by name inside its city.** The same name twice in one
 *   city is a duplicate; the same name in another city is another project.
 * * **Its units are found by name, and nothing points at it.** The Units tab is a
 *   `contains` on Inventories' own `project_name` — the shape that keeps this
 *   module from repeating why migration 031 removed the first one.
 * * **A brochure never carries how the business deals in it** — brokerage, the
 *   sales contact, the sales office, the inventory sheet, the internal notes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { propertyInput, signIn } from './fixtures.js';

const MARK = `zzprj${Date.now()}`;
const NAME = `${MARK} DLF The Arbour`;

let app: ReturnType<typeof createApp>;
let admin: string;
const made: string[] = [];

async function makeProject(body: Record<string, unknown>, token = admin): Promise<request.Response> {
  const res = await request(app)
    .post('/api/records/projects')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
  if (res.status === 201) made.push(res.body.id);
  return res;
}

beforeAll(async () => {
  app = createApp();
  admin = await signIn(app, 'admin@ipropy.com');
});

afterAll(async () => {
  if (made.length) await db.query(`DELETE FROM ipy_record WHERE id = ANY($1::uuid[])`, [made]);
});

describe('the Projects module', () => {
  it('is described, with its sections, and the admin may do everything', async () => {
    const res = await request(app).get('/api/meta/modules/projects').set('Authorization', `Bearer ${admin}`);
    expect(res.status, res.text).toBe(200);
    expect(res.body.label).toBe('Projects');
    expect(res.body.permissions).toMatchObject({ view: true, create: true, edit: true, delete: true });
    const fields = new Set((res.body.fields as { name: string }[]).map((f) => f.name));
    for (const name of [
      'project_name', 'developer', 'project_status', 'city', 'locality', 'rera_number',
      'launch_date', 'possession_date', 'total_towers', 'configurations', 'price_from',
      'price_to', 'payment_plans', 'amenities', 'brokerage_pct', 'sales_contact_mobile',
    ]) {
      expect(fields.has(name), `${name} is missing from Projects`).toBe(true);
    }
  });

  it('records a project with the facts a developer quotes', async () => {
    const res = await makeProject({
      project_name: NAME, developer: 'DLF', project_type: 'Residential',
      project_status: 'Under Construction', city: 'Faridabad', locality: 'Sector 76',
      rera_number: 'HRERA-PKL-FBD-123-2024', total_towers: 6,
      configurations: ['3 BHK', '4 BHK'], price_from: 21500000, price_to: 39000000,
      payment_plans: ['Construction Linked Plan (CLP)'], possession_date: '2029-03-31',
      brokerage_pct: 2, sales_contact_name: 'Site Office', sales_contact_mobile: '9876543210',
    });
    expect(res.status, res.text).toBe(201);
    expect(res.body.label).toBe(NAME);
    expect(res.body.values.configurations).toEqual(['3 BHK', '4 BHK']);
  });

  it('refuses the same project twice in one city, and allows it in another', async () => {
    const twice = await makeProject({ project_name: NAME, project_status: 'New Launch', city: 'Faridabad' });
    expect(twice.status, twice.text).toBe(409);
    const elsewhere = await makeProject({ project_name: NAME, project_status: 'New Launch', city: 'Gurugram' });
    expect(elsewhere.status, elsewhere.text).toBe(201);
  });

  it('answers its own views — New Launches is not Under Construction', async () => {
    const views = await request(app).get('/api/views/projects').set('Authorization', `Bearer ${admin}`);
    expect(views.status, views.text).toBe(200);
    const names = (views.body as { name: string }[]).map((v) => v.name);
    for (const name of ['All Projects', 'New Launches', 'Under Construction', 'Ready To Move']) {
      expect(names, `${name} view is missing`).toContain(name);
    }
    const res = await request(app)
      .post('/api/records/projects/search')
      .set('Authorization', `Bearer ${admin}`)
      .send({ search: MARK, filter: { logic: 'AND', conditions: [{ field: 'project_status', operator: 'in', value: ['Pre Launch', 'New Launch'] }] } });
    expect(res.status, res.text).toBe(200);
    const cities = (res.body.rows as { values: { city: string } }[]).map((r) => r.values.city);
    expect(cities).toEqual(['Gurugram']);
  });
});

describe("a project's units", () => {
  it('are the Inventories carrying its name, however a rep typed it', async () => {
    const unit = await request(app)
      .post('/api/records/properties')
      .set('Authorization', `Bearer ${admin}`)
      .send(propertyInput({ project_name: `  ${NAME.toLowerCase()} `, status: 'Available' }));
    expect(unit.status, unit.text).toBe(201);
    made.push(unit.body.id);

    // Exactly what the Units tab asks — `unitsOfProject` in the web package.
    const res = await request(app)
      .post('/api/records/properties/search')
      .set('Authorization', `Bearer ${admin}`)
      .send({ filter: { logic: 'AND', conditions: [{ field: 'project_name', operator: 'contains', value: NAME }] } });
    expect(res.status, res.text).toBe(200);
    expect((res.body.rows as { id: string }[]).map((r) => r.id)).toContain(unit.body.id);
  });
});

describe('who may do what', () => {
  it('lets a sales executive read projects but not add one', async () => {
    const exec = await signIn(app, 'aisha.khan@ipropy.com');
    const list = await request(app).post('/api/records/projects/search').set('Authorization', `Bearer ${exec}`).send({ search: MARK });
    expect(list.status, list.text).toBe(200);
    expect(list.body.rows.length).toBeGreaterThan(0);
    const add = await makeProject({ project_name: `${MARK} Exec`, project_status: 'New Launch', city: 'Delhi' }, exec);
    expect(add.status).toBe(403);
  });

  it('never shows a telecaller what the business earns on a project', async () => {
    const caller = await signIn(app, 'neha.gupta@ipropy.com');
    const res = await request(app).get(`/api/records/projects/${made[0]}`).set('Authorization', `Bearer ${caller}`);
    expect(res.status, res.text).toBe(200);
    expect(res.body.values.project_name).toBe(NAME);
    expect(res.body.values).not.toHaveProperty('brokerage_pct');
  });
});

describe('the brochure a buyer opens', () => {
  it('carries the project and never how it is dealt in', async () => {
    await request(app)
      .patch(`/api/records/projects/${made[0]}`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ sales_office: 'Behind the metro', inventory_sheet_url: 'https://example.com/sheet', internal_notes: 'Builder pays late' });
    const minted = await request(app)
      .post(`/api/records/projects/${made[0]}/share-links`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ label: 'For a buyer' });
    expect(minted.status, minted.text).toBe(201);
    const page = await request(app).get(`/api/public/share/${minted.body.token}`);
    expect(page.status, page.text).toBe(200);

    const shared = new Set((page.body.fields as { name: string }[]).map((f) => f.name));
    for (const secret of [
      'brokerage_pct', 'sales_contact_name', 'sales_contact_mobile', 'sales_office',
      'inventory_sheet_url', 'internal_notes', 'project_code',
    ]) {
      expect(shared.has(secret), `${secret} is on the brochure`).toBe(false);
      expect(page.body.property?.[secret], `${secret}'s value reached the brochure`).toBeUndefined();
    }
    const body = JSON.stringify(page.body);
    expect(body).not.toContain('9876543210');
    expect(body).not.toContain('Builder pays late');
    for (const wanted of ['configurations', 'price_from', 'possession_date', 'project_status']) {
      expect(shared.has(wanted), `${wanted} should be on the brochure`).toBe(true);
    }
  });
});
