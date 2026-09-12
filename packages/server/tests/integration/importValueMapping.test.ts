/**
 * What a value in the file means, decided per value.
 *
 * Growing the list automatically is right for a locality — there are hundreds
 * and the file knows them better than the CRM does. It is wrong for a status:
 * a portal export saying "Hot" should become the stage this team already
 * works, not a second one that no view, no report and no automation knows
 * about.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { signIn } from './fixtures.js';

let app: ReturnType<typeof createApp>;
let token = '';
let statusField = 'status';
let known = '';
const MOBILES = ['9800000071', '9800000072'];
const csv = Buffer.from(
  `Name,Phone,Stage\nOne,${MOBILES[0]},Hot\nTwo,${MOBILES[1]},Cold\n`, 'utf8');

const mapping = (): string => JSON.stringify({ Name: 'full_name', Phone: 'mobile', Stage: statusField });

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  const admin = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`);
  token = await signIn(app, admin!.email);

  const leads = await registry.requireModule('leads');
  const f = leads.fields.find((x) => x.columnName === 'status') ?? leads.fields.find((x) => x.uitype === 'picklist');
  statusField = f!.name;
  known = f!.options![0]!.value;
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_record r USING ipy_e_leads l
                   WHERE l.record_id = r.id AND l.mobile = ANY($1::text[])`, [MOBILES]);
});

describe('mapping the values inside a column', () => {
  it('lists what is in the column, and what the CRM already has for it', async () => {
    const res = await request(app).post('/api/import/leads/values')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', csv, 'values.csv').field('mapping', mapping()).expect(200);

    const column = (res.body.columns as { field: string; values: { raw: string; count: number; match: string | null }[] }[])
      .find((c) => c.field === statusField);
    expect(column?.values.map((v) => v.raw).sort()).toEqual(['Cold', 'Hot']);
    expect(column?.values.every((v) => v.match === null),
      'neither is a stage this CRM has').toBe(true);
  });

  it('writes the value chosen, and leaves the cell empty when that is the choice', async () => {
    const res = await request(app).post('/api/import/leads/dry-run')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', csv, 'values.csv')
      .field('mapping', mapping())
      .field('valueMap', JSON.stringify({ [statusField]: { Hot: known, Cold: '' } }))
      .expect(200);

    const rows = res.body.rows as { values: Record<string, unknown> }[];
    expect(rows[0].values[statusField]).toBe(known);
    expect(rows[1].values[statusField], 'left empty on purpose').toBeUndefined();
    expect(res.body.optionsAdded,
      'a value somebody has answered for is not a new option').toEqual([]);
  });
});
