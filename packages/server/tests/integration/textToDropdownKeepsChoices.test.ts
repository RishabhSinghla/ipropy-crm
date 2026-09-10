/**
 * Text → Dropdown has to produce a dropdown somebody can use.
 *
 * The conversion kept every value and attached no option list, so the field
 * arrived as a select with nothing in it: "3 BHK" was still on the record, was
 * not offered by the control, and could not be chosen again on the next one.
 * The values were technically preserved and the field was unusable — the worst
 * of both, and the kind of thing that passes a "did the data survive" check.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';

let app: ReturnType<typeof createApp>;
let token = '';
let fieldId = '';
const NAME = `qa_conv_${Date.now().toString(36)}`;

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  const admin = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`,
  );
  token = (await request(app).post('/api/auth/login')
    .send({ email: admin!.email, password: 'Admin@123' })).body.token;
});

afterAll(async () => {
  if (fieldId) await request(app).delete(`/api/meta/fields/${fieldId}?permanent=true&confirm=true`)
    .set('Authorization', `Bearer ${token}`);
  await db.query(`DELETE FROM ipy_picklist_value WHERE picklist_id IN (SELECT id FROM ipy_picklist WHERE name = $1)`, [`leads_${NAME}`]);
  await db.query(`DELETE FROM ipy_picklist WHERE name = $1`, [`leads_${NAME}`]);
  await db.query(`DELETE FROM ipy_dropped_column WHERE column_name = $1`, [NAME]);
});

describe('converting a text field to a dropdown', () => {
  it('builds the option list out of the values the records already hold', async () => {
    const mod = await request(app).get('/api/meta/modules/leads?includeInactive=true')
      .set('Authorization', `Bearer ${token}`).expect(200);
    const created = await request(app).post('/api/meta/modules/leads/fields')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: NAME, label: 'QA conversion', uitype: 'string', blockId: mod.body.blocks[0].id, config: {} })
      .expect(201);
    fieldId = created.body.id;

    const rows = (await request(app).get('/api/records/leads?pageSize=3')
      .set('Authorization', `Bearer ${token}`).expect(200)).body.rows.map((r: { id: string }) => r.id);
    const values = ['3 BHK', '4 BHK', '3 BHK'];
    for (const [i, id] of rows.entries()) {
      await request(app).patch(`/api/records/leads/${id}`)
        .set('Authorization', `Bearer ${token}`).send({ [NAME]: values[i] }).expect(200);
    }

    await request(app).post(`/api/meta/fields/${fieldId}/type-conversion`)
      .set('Authorization', `Bearer ${token}`)
      .send({ targetType: 'picklist', invalidStrategy: 'blank' })
      .expect(200);

    const after = (await request(app).get('/api/meta/modules/leads?includeInactive=true')
      .set('Authorization', `Bearer ${token}`).expect(200)).body.fields.find((f: { name: string }) => f.name === NAME);
    expect(after.uitype).toBe('picklist');
    expect(after.config.picklist, 'the new dropdown must be attached to an option list').toBeTruthy();

    const options = await db.query<{ value: string }>(
      `SELECT v.value FROM ipy_picklist_value v JOIN ipy_picklist p ON p.id = v.picklist_id
        WHERE p.name = $1 ORDER BY v.sequence`, [after.config.picklist],
    );
    // Distinct, so the duplicate "3 BHK" is one option and not two.
    expect(options.rows.map((r) => r.value)).toEqual(['3 BHK', '4 BHK']);

    // And the records still read back what they held.
    const first = await request(app).get(`/api/records/leads/${rows[0]}`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(first.body.values[NAME]).toBe('3 BHK');
  });
});
