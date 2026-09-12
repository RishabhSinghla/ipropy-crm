/**
 * A file that arrives every week is mapped once.
 *
 * The mapping is stored against permanent field ids, so the template survives
 * the thing that actually happens to this CRM: somebody renames a field.
 * "Demand" became "Base Price" on production in August, and a template keyed
 * on the name would have quietly mapped that column to nothing.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { signIn } from './fixtures.js';

let app: ReturnType<typeof createApp>;
let token = '';
let templateId = '';
/** Looked up rather than written down: the seeded name for this differs from production's. */
let statusField = 'status';
const NAME = `QA Weekly ${Date.now().toString(36)}`;
const HEADERS = ['Customer Name', 'Mobile No', 'Budget'];
const file = (headers: string[]): Buffer =>
  Buffer.from(`${headers.join(',')}\nSomebody,9800011122,1 Cr\n`, 'utf8');

const preview = async (headers: string[]): Promise<Record<string, unknown>> => (
  await request(app).post('/api/import/leads/preview')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', file(headers), 'weekly.csv').expect(200)
).body;

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  const admin = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`);
  token = await signIn(app, admin!.email);

  const status = await db.queryOne<{ name: string }>(
    `SELECT f.name FROM ipy_field f JOIN ipy_module m ON m.id = f.module_id
      WHERE m.name = 'leads' AND f.column_name = 'status'`);
  statusField = status!.name;

  const saved = await request(app).post('/api/import/leads/templates')
    .set('Authorization', `Bearer ${token}`)
    .send({
      name: NAME,
      headers: HEADERS,
      mapping: { 'Customer Name': 'full_name', 'Mobile No': 'mobile', Budget: 'budget' },
      staticValues: { [statusField]: 'New' },
      settings: { importMode: 'upsert', dateOrder: 'dmy' },
    }).expect(201);
  templateId = saved.body.id;
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_import_template WHERE id = $1`, [templateId]);
});

describe('saved import mappings', () => {
  it('recognises the same file next week', async () => {
    const body = await preview(HEADERS) as {
      template: { name: string; mapping: Record<string, string>;
        staticValues: Record<string, string>; settings: Record<string, string> } | null;
      suggestedMapping: Record<string, string>;
    };
    expect(body.template?.name).toBe(NAME);
    expect(body.template?.mapping).toMatchObject({ Budget: 'budget' });
    expect(body.template?.staticValues).toMatchObject({ [statusField]: 'New' });
    expect(body.template?.settings).toMatchObject({ importMode: 'upsert' });
    expect(body.suggestedMapping.Budget, 'the saved answer is the starting point').toBe('budget');
  });

  it('still recognises a file that gained a column', async () => {
    const body = await preview([...HEADERS, 'Remarks']) as { template: { name: string } | null };
    expect(body.template?.name).toBe(NAME);
  });

  it('does not claim a file that merely shares one heading', async () => {
    const body = await preview(['Customer Name', 'Site', 'Floor', 'Facing']) as
      { template: { name: string } | null };
    expect(body.template).toBeFalsy();
  });

  it('follows a renamed field instead of losing the column', async () => {
    const field = await db.queryOne<{ id: string; name: string }>(
      `SELECT f.id, f.name FROM ipy_field f JOIN ipy_module m ON m.id = f.module_id
        WHERE m.name = 'leads' AND f.name = 'budget'`);
    const renamed = `budget_qa_${Date.now().toString(36)}`;
    await db.query(`UPDATE ipy_field SET name = $2 WHERE id = $1`, [field!.id, renamed]);
    registry.invalidate();
    try {
      const body = await preview(HEADERS) as { template: { mapping: Record<string, string> } | null };
      expect(body.template?.mapping.Budget,
        'the template points at the field, not at what it used to be called').toBe(renamed);
    } finally {
      await db.query(`UPDATE ipy_field SET name = $2 WHERE id = $1`, [field!.id, field!.name]);
      registry.invalidate();
    }
  });
});
