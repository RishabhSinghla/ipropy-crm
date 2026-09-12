/**
 * What an administrator can reshape, and what the CRM refuses to let them break.
 *
 * The admin panel's promise is that the data model is data — rename a field,
 * change its type, delete a section, and no developer is involved. Three of
 * those were refused outright until now, and one of them was refused in a way
 * nobody could work around: a section that came with the CRM could never be
 * deleted however empty it was, so the Section dropdown kept offering blocks
 * nobody wanted.
 *
 * The interesting half is the refusals. A rename that silently orphans a saved
 * view, or a type change that makes every write to a column fail, is worse than
 * a "no" with a reason.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { signIn } from './fixtures.js';

let app: Express;
let token: string;

const unique = (): string => Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

async function describeLeads(): Promise<{
  blocks: { id: string; name: string; label: string; fields: { name: string }[] }[];
  fields: { id: string; name: string; uitype: string; isCustom: boolean }[];
}> {
  const res = await request(app)
    .get('/api/meta/modules/leads?includeInactive=true')
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  return res.body;
}

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  const admin = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`,
  );
  token = await signIn(app, admin!.email);
});

describe('renaming a field', () => {
  it('moves no data and takes every reference with it', async () => {
    const meta = await describeLeads();
    const blockId = meta.blocks[0].id;
    const from = `qa_rename_${unique()}`;
    const to = `${from}_renamed`;

    const created = await request(app)
      .post('/api/meta/modules/leads/fields')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: from, label: 'QA rename', uitype: 'string', blockId, config: {} })
      .expect(201);
    const fieldId = created.body.id as string;

    // A record holding a value, and a saved view that lists and filters on it —
    // the two things a rename must not lose.
    const record = await request(app)
      .post('/api/records/leads')
      .set('Authorization', `Bearer ${token}`)
      .send({ full_name: `Rename Subject ${unique()}`, mobile: '9812345671', [from]: 'keep me' })
      .expect(201);
    const recordId = record.body.id as string;

    const module = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_module WHERE name = 'leads'`);
    const view = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_view (module_id, name, columns, filter)
       VALUES ($1, $2, $3::jsonb, $4::jsonb) RETURNING id`,
      [
        module!.id, `QA rename view ${unique()}`,
        JSON.stringify(['full_name', from]),
        JSON.stringify({ logic: 'AND', conditions: [{ field: from, operator: 'equals', value: 'keep me' }] }),
      ],
    );

    try {
      const renamed = await request(app)
        .patch(`/api/meta/fields/${fieldId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: to })
        .expect(200);
      expect(renamed.body.renamed).toMatchObject({ from, to });

      // The value is still on the record, under the new name.
      const read = await request(app)
        .get(`/api/records/leads/${recordId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(read.body.values[to]).toBe('keep me');
      expect(read.body.values[from]).toBeUndefined();

      // And the saved view points at the new name rather than at nothing.
      const after = await db.queryOne<{ columns: string[]; filter: { conditions: { field: string }[] } }>(
        `SELECT columns, filter FROM ipy_view WHERE id = $1`, [view!.id],
      );
      expect(after!.columns).toContain(to);
      expect(after!.columns).not.toContain(from);
      expect(after!.filter.conditions[0].field).toBe(to);
    } finally {
      await db.query(`DELETE FROM ipy_view WHERE id = $1`, [view!.id]);
      await request(app).delete(`/api/records/leads/${recordId}`).set('Authorization', `Bearer ${token}`);
      await request(app).delete(`/api/meta/fields/${fieldId}?permanent=true`).set('Authorization', `Bearer ${token}`);
    }
  });

  /**
   * Even the fields the engine reads can be renamed now.
   *
   * This used to be refused, and the refusal was the single most-hit wall in the
   * admin screen: "we are fully customisable, right?" Renaming was always safe
   * for the data — `column_name` does not move — and the references living in
   * views, filters, layouts and workflows are rewritten by the pass above. The
   * one real risk was a handful of features holding a literal field name in the
   * source, and those find their field by its storage column now.
   *
   * Deleting one is still refused, which is the line that matters: an admin can
   * call a field anything, but not remove what the engine runs on.
   */
  it('allows renaming a field the CRM reads, and keeps it working', async () => {
    const mobile = (await describeLeads()).fields.find((f) => f.name === 'mobile');
    expect(mobile).toBeTruthy();

    await request(app)
      .patch(`/api/meta/fields/${mobile!.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'mobile_number' })
      .expect(200);

    const renamed = (await describeLeads()).fields.find((f) => f.id === mobile!.id);
    expect(renamed?.name).toBe('mobile_number');
    // The data did not move, which is why the rename is safe at all.
    expect(renamed?.columnName).toBe(mobile!.columnName);

    // Put it back: every other suite shares this database and looks for `mobile`.
    await request(app)
      .patch(`/api/meta/fields/${mobile!.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'mobile' })
      .expect(200);
    expect((await describeLeads()).fields.some((f) => f.name === 'mobile')).toBe(true);
  });

  it('refuses a name another field already has', async () => {
    const meta = await describeLeads();
    const target = meta.fields.find((f) => f.name === 'company');
    await request(app)
      .patch(`/api/meta/fields/${target!.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'designation' })
      .expect(409);
  });
});

describe('changing a field type', () => {
  it('allows a swap between types that share the same column', async () => {
    const meta = await describeLeads();
    const email = meta.fields.find((f) => f.name === 'secondary_email');
    try {
      await request(app)
        .patch(`/api/meta/fields/${email!.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ uitype: 'string' })
        .expect(200);
      expect((await describeLeads()).fields.find((f) => f.name === 'secondary_email')!.uitype)
        .toBe('string');
    } finally {
      await request(app)
        .patch(`/api/meta/fields/${email!.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ uitype: 'email' });
    }
  });

  /*
    A type change the column cannot absorb is an ALTER TABLE now, not a
    refusal — the old behaviour told the admin to build a second field and
    delete the first, which loses every value and every reference to the name.

    What survives from that refusal is the honest half: a conversion that would
    clear values says how many first, and does nothing until the caller has
    answered. Date → Text loses nothing, so it goes straight through; the
    reverse would empty every row that was never a date, so it is refused until
    `confirmDataLoss` comes back.
  */
  it('changes a column-backed type outright when nothing is lost', async () => {
    const meta = await describeLeads();
    const dob = meta.fields.find((f) => f.name === 'date_of_birth');
    try {
      const res = await request(app)
        .patch(`/api/meta/fields/${dob!.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ uitype: 'string' })
        .expect(200);
      expect(res.body.uitype).toBe('string');
      expect(res.body.converted).toMatchObject({ from: 'date', to: 'string', cleared: 0 });
    } finally {
      await request(app)
        .patch(`/api/meta/fields/${dob!.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ uitype: 'date', confirmDataLoss: true });
    }
  });

  it('asks before a type change that would clear values, then does it', async () => {
    const meta = await describeLeads();
    const name = meta.fields.find((f) => f.name === 'full_name');

    // Full Name is text on every record and none of it is a date, so the
    // count is the whole table — exactly the case the admin must see first.
    const refused = await request(app)
      .patch(`/api/meta/fields/${name!.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ uitype: 'date' })
      .expect(400);
    expect(refused.body.message).toMatch(/clears the value on \d+ record/i);
    expect(refused.body.details?.needsConfirmation).toBe(true);

    // Not sent again without the answer: the field is untouched.
    const after = await describeLeads();
    expect(after.fields.find((f) => f.name === 'full_name')?.uitype).toBe('string');
  });

  it('lets an admin-created field become anything, since it is stored as a document', async () => {
    const meta = await describeLeads();
    const name = `qa_retype_${unique()}`;
    const created = await request(app)
      .post('/api/meta/modules/leads/fields')
      .set('Authorization', `Bearer ${token}`)
      .send({ name, label: 'QA retype', uitype: 'string', blockId: meta.blocks[0].id, config: {} })
      .expect(201);
    try {
      await request(app)
        .patch(`/api/meta/fields/${created.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ uitype: 'date' })
        .expect(200);
    } finally {
      await request(app)
        .delete(`/api/meta/fields/${created.body.id}?permanent=true`)
        .set('Authorization', `Bearer ${token}`);
    }
  });
});

describe('sections', () => {
  it('deletes an empty section and takes it off every layout', async () => {
    const name = `qa_section_${unique()}`;
    const created = await request(app)
      .post('/api/meta/modules/leads/blocks')
      .set('Authorization', `Bearer ${token}`)
      .send({ name, label: 'QA section' })
      .expect(201);

    const module = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_module WHERE name = 'leads'`);
    const layout = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_layout (module_id, name, type, config)
       VALUES ($1, $2, 'detail', $3::jsonb) RETURNING id`,
      [module!.id, `QA layout ${unique()}`, JSON.stringify({
        blocks: [{ key: name, label: 'QA section', columns: 2, fields: [] }],
      })],
    );

    try {
      await request(app)
        .delete(`/api/meta/blocks/${created.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((await describeLeads()).blocks.some((b) => b.name === name)).toBe(false);

      const after = await db.queryOne<{ config: { blocks: { key: string }[] } }>(
        `SELECT config FROM ipy_layout WHERE id = $1`, [layout!.id],
      );
      expect(after!.config.blocks.some((b) => b.key === name)).toBe(false);
    } finally {
      await db.query(`DELETE FROM ipy_layout WHERE id = $1`, [layout!.id]);
      await db.query(`DELETE FROM ipy_block WHERE id = $1`, [created.body.id]);
    }
  });

  it('deletes a section that came with the CRM, not only one an admin added', async () => {
    // The whole complaint: KYC and Communication Preferences sat empty on
    // Modules & Fields with no way to remove them, because the route only ever
    // deleted `is_custom` rows.
    const meta = await describeLeads();
    const seeded = meta.blocks.find((b) => b.fields.length === 0
      && !['basic', 'basic_information'].includes(b.name));
    if (!seeded) return; // nothing empty to remove in this database
    const row = await db.queryOne<{ name: string; label: string; sequence: number; columns: number }>(
      `SELECT name, label, sequence, columns FROM ipy_block WHERE id = $1`, [seeded.id],
    );

    await request(app)
      .delete(`/api/meta/blocks/${seeded.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((await describeLeads()).blocks.some((b) => b.name === seeded.name)).toBe(false);

    // Put it back, so the rest of the suite sees the database it expects.
    await request(app)
      .post('/api/meta/modules/leads/blocks')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: row!.name, label: row!.label, sequence: row!.sequence, columns: row!.columns })
      .expect(201);
  });

  it('stays deleted when the seed runs again', async () => {
    // The trap that made the delete button look broken: the seed rebuilds every
    // section on every cold start, which on a free-tier instance is about once
    // an hour. Without a tombstone the section came back on its own.
    const name = `qa_tombstone_${unique()}`;
    const created = await request(app)
      .post('/api/meta/modules/leads/blocks')
      .set('Authorization', `Bearer ${token}`)
      .send({ name, label: 'QA tombstone' })
      .expect(201);

    try {
      await request(app)
        .delete(`/api/meta/blocks/${created.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const stone = await db.queryOne<{ block_name: string }>(
        `SELECT block_name FROM ipy_block_tombstone WHERE module_name = 'leads' AND block_name = $1`,
        [name],
      );
      expect(stone?.block_name).toBe(name);
    } finally {
      await db.query(`DELETE FROM ipy_block_tombstone WHERE block_name = $1`, [name]);
      await db.query(`DELETE FROM ipy_block WHERE id = $1`, [created.body.id]);
    }
  });

  it('lifts the tombstone when the same section is added back', async () => {
    const name = `qa_revive_${unique()}`;
    const created = await request(app)
      .post('/api/meta/modules/leads/blocks')
      .set('Authorization', `Bearer ${token}`)
      .send({ name, label: 'QA revive' })
      .expect(201);
    await request(app)
      .delete(`/api/meta/blocks/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const again = await request(app)
      .post('/api/meta/modules/leads/blocks')
      .set('Authorization', `Bearer ${token}`)
      .send({ name, label: 'QA revive' })
      .expect(201);
    try {
      const stone = await db.queryOne<{ block_name: string }>(
        `SELECT block_name FROM ipy_block_tombstone WHERE block_name = $1`, [name],
      );
      expect(stone).toBeNull();
    } finally {
      await db.query(`DELETE FROM ipy_block WHERE id = $1`, [again.body.id]);
    }
  });

  it('keeps a renamed section, so a cold start cannot put the old name back', async () => {
    const name = `qa_rename_section_${unique()}`;
    const created = await request(app)
      .post('/api/meta/modules/leads/blocks')
      .set('Authorization', `Bearer ${token}`)
      .send({ name, label: 'Before' })
      .expect(201);
    try {
      await request(app)
        .patch(`/api/meta/blocks/${created.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ label: 'After' })
        .expect(200);
      const row = await db.queryOne<{ label: string; is_customised: boolean }>(
        `SELECT label, is_customised FROM ipy_block WHERE id = $1`, [created.body.id],
      );
      expect(row).toMatchObject({ label: 'After', is_customised: true });
    } finally {
      await db.query(`DELETE FROM ipy_block WHERE id = $1`, [created.body.id]);
    }
  });

  it('refuses to delete a section that still holds fields', async () => {
    const meta = await describeLeads();
    const populated = meta.blocks.find((b) => b.fields.length > 0);
    const res = await request(app)
      .delete(`/api/meta/blocks/${populated!.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
    expect(res.body.message).toMatch(/still holds/i);
  });
});
