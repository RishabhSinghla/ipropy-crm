/**
 * A rep finds a record that is not theirs, asks for it, and the owner hands it
 * over — or does not.
 *
 * **3 October 2026, the owner:** *"When an Agent/user search any thing from the
 * search then he didn't see the record, bcoz he is not actual owner of this
 * record … i need a solution that if the agent/user search the any thing, then
 * system will display the record name on the screen and if agent want to access
 * the display record, he can ask to actual owner of record for the permission to
 * assigned him, Now The actual user can change the owner of record."*
 *
 * Every promise here needs a real database: the scoping is SQL, the uniqueness
 * is an index, and "asking grants nothing" is only true if a real `getRecord`
 * still refuses afterwards.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { contextFor, leadInput, signIn, SEEDED } from './fixtures.js';

let app: Express;
let owner = '';
let stranger = '';
let recordId = '';
let label = '';

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  owner = await signIn(app, SEEDED.executiveA);
  stranger = await signIn(app, SEEDED.executiveB);

  // A lead owned by one executive. Leads are private, so the other executive
  // cannot see it — which is the whole situation this feature is about.
  const ctx = await contextFor(SEEDED.executiveA);
  label = `Ask owner ${Date.now()}`;
  const made = await recordService.createRecord(ctx, 'leads', leadInput({ full_name: label }));
  recordId = made.id;
});

describe('asking the owner for a record', () => {
  it('names the record in search without handing any of it over', async () => {
    const res = await request(app).get('/api/search')
      .query({ q: label })
      .set('Authorization', `Bearer ${stranger}`)
      .expect(200);
    const hit = (res.body as Array<Record<string, unknown>>).find((row) => row.label === label);
    expect(hit, 'the record should be named to somebody who cannot open it').toBeTruthy();
    expect(hit!.restricted).toBe(true);
    // A name, a module and an owner. Nothing else — no fields ever travel on
    // one of these, which is what keeps it a doorbell rather than a key.
    expect(Object.keys(hit!).sort()).toEqual(
      ['id', 'label', 'module', 'moduleLabel', 'ownerId', 'ownerName', 'recordNumber', 'restricted'].sort(),
    );
  });

  it('still refuses the record itself', async () => {
    await request(app).get(`/api/records/leads/${recordId}`)
      .set('Authorization', `Bearer ${stranger}`)
      .expect((res) => { expect([403, 404]).toContain(res.status); });
  });

  it('records one open request however many times it is asked', async () => {
    await request(app).post('/api/access-requests')
      .send({ recordId, note: 'They rang me this morning' })
      .set('Authorization', `Bearer ${stranger}`)
      .expect(201);
    // Asking twice is the same person still waiting, not a second request.
    await request(app).post('/api/access-requests')
      .send({ recordId })
      .set('Authorization', `Bearer ${stranger}`)
      .expect(201);

    const mine = await request(app).get('/api/access-requests')
      .set('Authorization', `Bearer ${stranger}`)
      .expect(200);
    const open = (mine.body.mine as Array<{ recordId: string; status: string }>)
      .filter((row) => row.recordId === recordId && row.status === 'pending');
    expect(open).toHaveLength(1);
  });

  it('shows the owner who is asking, and nobody else', async () => {
    const seen = await request(app).get(`/api/access-requests/record/${recordId}`)
      .set('Authorization', `Bearer ${owner}`)
      .expect(200);
    expect(seen.body).toHaveLength(1);
    expect(seen.body[0].note).toBe('They rang me this morning');

    // The person asking is not told who else wants it.
    const theirs = await request(app).get(`/api/access-requests/record/${recordId}`)
      .set('Authorization', `Bearer ${stranger}`)
      .expect(200);
    expect(theirs.body).toHaveLength(0);
  });

  it('refuses a stranger trying to answer their own request', async () => {
    const seen = await request(app).get(`/api/access-requests/record/${recordId}`)
      .set('Authorization', `Bearer ${owner}`)
      .expect(200);
    await request(app).post(`/api/access-requests/${seen.body[0].id}/grant`)
      .set('Authorization', `Bearer ${stranger}`)
      .expect(403);
  });

  it('hands the record over when the owner grants it, and the record moves', async () => {
    const seen = await request(app).get(`/api/access-requests/record/${recordId}`)
      .set('Authorization', `Bearer ${owner}`)
      .expect(200);
    await request(app).post(`/api/access-requests/${seen.body[0].id}/grant`)
      .set('Authorization', `Bearer ${owner}`)
      .expect(200);

    // The reassignment is real: the person who asked can now open it…
    await request(app).get(`/api/records/leads/${recordId}`)
      .set('Authorization', `Bearer ${stranger}`)
      .expect(200);
    // …and nothing is left waiting.
    const after = await request(app).get(`/api/access-requests/record/${recordId}`)
      .set('Authorization', `Bearer ${stranger}`)
      .expect(200);
    expect(after.body).toHaveLength(0);
  });

  it('will not answer a request twice', async () => {
    const mine = await request(app).get('/api/access-requests')
      .set('Authorization', `Bearer ${stranger}`)
      .expect(200);
    const granted = (mine.body.mine as Array<{ id: string; recordId: string; status: string }>)
      .find((row) => row.recordId === recordId && row.status === 'granted');
    expect(granted).toBeTruthy();
    await request(app).post(`/api/access-requests/${granted!.id}/decline`)
      .set('Authorization', `Bearer ${stranger}`)
      .expect(400);
  });
});
