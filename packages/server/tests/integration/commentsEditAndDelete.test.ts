/**
 * Comments: edited in place with their history kept, deleted by admins only.
 *
 * The owner, 3 October 2026: *"make our notes/comments editable … and on hover
 * show edit versions"*, and *"those notes/comments delete be allowed but to
 * admins only by default"*. So the author edits and every earlier wording
 * reaches the Activity feed; the author may **not** delete their own comment
 * any more, an admin may, and so may a profile an admin gives
 * `comments.delete`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { adminContext, SEEDED, signIn } from './fixtures.js';

let app: Express;
let adminToken = '';
let repToken = '';
let recordId = '';

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  adminToken = await signIn(app, 'admin@ipropy.com');
  repToken = await signIn(app, SEEDED.executiveA);
  const lead = await recordService.createRecord(await adminContext(), 'leads', {
    full_name: `Comment Edits ${Date.now()}`,
    mobile: `97${String(Date.now()).slice(-8)}`,
  });
  recordId = lead.id;
  // The rep has to be able to open the record to comment on it at all.
  await db.query(
    `UPDATE ipy_record SET owner_id = (SELECT id FROM ipy_user WHERE email = $2) WHERE id = $1`,
    [recordId, SEEDED.executiveA],
  );
});

afterAll(async () => {
  if (recordId) await db.query(`DELETE FROM ipy_record WHERE id = $1`, [recordId]);
});

async function postAs(token: string, body: string): Promise<string> {
  const res = await request(app).post(`/api/records/leads/${recordId}/comments`)
    .set('Authorization', `Bearer ${token}`)
    .send({ body })
    .expect(201);
  return res.body.id as string;
}

describe('comments', () => {
  it('keeps every earlier wording and hands it to the Activity feed', async () => {
    const id = await postAs(repToken, 'Rang them, call back Tusday');
    await request(app).patch(`/api/records/leads/${recordId}/comments/${id}`)
      .set('Authorization', `Bearer ${repToken}`)
      .send({ body: 'Rang them, call back Tuesday' })
      .expect(200);

    const timeline = await request(app).get(`/api/records/leads/${recordId}/timeline`)
      .set('Authorization', `Bearer ${repToken}`)
      .expect(200);
    const entry = (timeline.body as { id: string; body: string; meta: Record<string, unknown> }[])
      .find((item) => item.id === `comment-${id}`);
    expect(entry?.body).toBe('Rang them, call back Tuesday');
    expect(entry?.meta.commentId).toBe(id);
    expect((entry?.meta.editHistory as { body: string }[]).map((version) => version.body))
      .toEqual(['Rang them, call back Tusday']);
  });

  it('does not let the author delete their own comment', async () => {
    const id = await postAs(repToken, 'Mine, and staying');
    await request(app).delete(`/api/records/leads/${recordId}/comments/${id}`)
      .set('Authorization', `Bearer ${repToken}`)
      .expect(403);
    const still = await db.queryOne(`SELECT 1 FROM ipy_comment WHERE id = $1`, [id]);
    expect(still).toBeTruthy();
  });

  it('lets an admin delete anybody\'s comment', async () => {
    const id = await postAs(repToken, 'Posted by mistake');
    await request(app).delete(`/api/records/leads/${recordId}/comments/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const gone = await db.queryOne(`SELECT 1 FROM ipy_comment WHERE id = $1`, [id]);
    expect(gone).toBeFalsy();
  });
});

describe('rewrite with AI', () => {
  it('always hands a note back, and never saves it', async () => {
    const before = await db.queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM ipy_comment WHERE record_id = $1`, [recordId]);
    const res = await request(app).post('/api/ai/rewrite-note')
      .set('Authorization', `Bearer ${repToken}`)
      .send({ text: 'client ko 3bhk pasand aaya budget 1.2 cr' })
      .expect(200);
    expect(typeof res.body.note).toBe('string');
    expect(res.body.note.length).toBeGreaterThan(0);
    expect(typeof res.body.rewritten).toBe('boolean');
    const after = await db.queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM ipy_comment WHERE record_id = $1`, [recordId]);
    expect(after?.n).toBe(before?.n);
  });

  it('refuses an empty box', async () => {
    await request(app).post('/api/ai/rewrite-note')
      .set('Authorization', `Bearer ${repToken}`)
      .send({ text: '   ' })
      .expect(422);
  });
});
