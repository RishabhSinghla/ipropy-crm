/**
 * The view switcher ships with two views, and editing one is personal.
 *
 * "All Leads" and "My Leads" are one row each, read by the whole team. Making
 * them editable — which is the point, since they are the two views everybody
 * actually lives in — could not mean letting one person reshape the row
 * everybody reads. So an edit to a built-in view is saved as that person's own
 * version of it, and everyone else goes on seeing the built-in one
 * (migration 135).
 *
 * Three things here are easy to get wrong in ways nothing else would catch:
 *
 *  - The override has to be *invisible as a separate view*. A bug here shows
 *    up as two near-identical entries in the switcher, which reads as the save
 *    having duplicated something.
 *  - Asking for records **by the built-in view's id** has to honour the
 *    override, because every link made before the edit names that id. Get this
 *    wrong and the switcher says one thing while the list shows another.
 *  - A person's override must not leak into anybody else's list. This is the
 *    one that would be a real incident rather than a confusing screen.
 *
 * Sharing is tested here too, because it is the other half of the same
 * question: who can see a view that is not theirs.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { adminEmail, SEEDED, signIn } from './fixtures.js';

let app: Express;
let adminToken: string;
let executiveToken: string;
let executiveId: string;

interface ViewRow {
  id: string;
  builtInId?: string;
  name: string;
  isSystem: boolean;
  isOverride?: boolean;
  columns: string[];
  sharedWith?: string[];
}

const views = async (token: string): Promise<ViewRow[]> => {
  const res = await request(app).get('/api/views/leads').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body as ViewRow[];
};

beforeAll(async () => {
  await registry.warmup();
  app = createApp();

  // `signIn` and `adminEmail` rather than a hand-rolled login: a refused login
  // otherwise leaves `undefined` in the token and the run fails somewhere else
  // with a 401 nobody can trace. `integrationSuiteHygiene` enforces it.
  adminToken = await signIn(app, await adminEmail());
  executiveToken = await signIn(app, SEEDED.executiveA);
  const exec = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_user WHERE email = $1`, [SEEDED.executiveA]);
  executiveId = exec!.id;
});

describe('the two built-in views', () => {
  it('are what the switcher opens with', async () => {
    const list = await views(adminToken);
    const builtIn = list.filter((v) => v.isSystem).map((v) => v.name).sort();
    expect(builtIn).toEqual(['All Leads', 'My Leads']);
  });

  it('cannot be deleted by anyone, administrator included', async () => {
    const all = (await views(adminToken)).find((v) => v.name === 'All Leads')!;
    const res = await request(app)
      .delete(`/api/views/leads/${all.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(403);

    // Still there, and still one of two.
    expect((await views(adminToken)).filter((v) => v.isSystem)).toHaveLength(2);
  });
});

describe('editing a built-in view', () => {
  it('saves your own version rather than reshaping the shared row', async () => {
    const before = (await views(executiveToken)).find((v) => v.name === 'All Leads')!;
    expect(before.isSystem).toBe(true);
    expect(before.isOverride).toBeFalsy();

    const saved = await request(app)
      .put(`/api/views/leads/${before.id}`)
      .set('Authorization', `Bearer ${executiveToken}`)
      .send({ columns: ['full_name', 'mobile'] });
    expect(saved.status).toBe(200);
    expect(saved.body.personal).toBe(true);

    const after = await views(executiveToken);
    // One entry, not two: the override is folded into the built-in view's slot.
    expect(after.filter((v) => v.name === 'All Leads')).toHaveLength(1);
    const mine = after.find((v) => v.name === 'All Leads')!;
    expect(mine.isOverride).toBe(true);
    expect(mine.columns).toEqual(['full_name', 'mobile']);
    // The built-in row is still reachable, which is what Reset deletes against
    // and what an older link names.
    expect(mine.builtInId).toBe(before.id);
    expect(mine.id).not.toBe(before.id);
  });

  it('leaves everybody else on the built-in one', async () => {
    const theirs = (await views(adminToken)).find((v) => v.name === 'All Leads')!;
    expect(theirs.isOverride).toBeFalsy();
    expect(theirs.columns).toEqual([]);
  });

  it('is honoured when records are asked for by the built-in id', async () => {
    /*
      The case a link made before the edit exercises. The switcher sends the
      override's own id; a bookmark, a dashboard drill-through or a pasted URL
      still names the built-in one, and both have to resolve to the same thing
      for the person who edited it.
    */
    const mine = (await views(executiveToken)).find((v) => v.name === 'All Leads')!;

    const byOverride = await request(app)
      .get(`/api/records/leads?view=${mine.id}&pageSize=1`)
      .set('Authorization', `Bearer ${executiveToken}`);
    const byBuiltIn = await request(app)
      .get(`/api/records/leads?view=${mine.builtInId}&pageSize=1`)
      .set('Authorization', `Bearer ${executiveToken}`);

    expect(byOverride.status).toBe(200);
    expect(byBuiltIn.status).toBe(200);
    const columnsOf = (res: { body: { rows: { values: Record<string, unknown> }[] } }): string[] => (
      Object.keys(res.body.rows[0]?.values ?? {}).sort()
    );
    expect(columnsOf(byBuiltIn)).toEqual(columnsOf(byOverride));
  });

  it('is undone by resetting, without touching the built-in view', async () => {
    const mine = (await views(executiveToken)).find((v) => v.name === 'All Leads')!;
    const res = await request(app)
      .delete(`/api/views/leads/${mine.builtInId}/override`)
      .set('Authorization', `Bearer ${executiveToken}`);
    expect(res.status).toBe(200);

    const after = (await views(executiveToken)).find((v) => v.name === 'All Leads')!;
    expect(after.isOverride).toBeFalsy();
    expect(after.columns).toEqual([]);
    expect(after.id).toBe(after.builtInId);
  });
});

describe('sharing a view with named people', () => {
  it('reaches exactly the people named, and nobody else', async () => {
    const created = await request(app)
      .post('/api/views/leads')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `Shared with one ${Date.now()}`,
        columns: ['full_name'],
        filter: { logic: 'AND', conditions: [] },
        sharedWith: [executiveId],
      });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    const mine = (await views(adminToken)).find((v) => v.id === id);
    expect(mine?.sharedWith).toEqual([executiveId]);

    // The person it was shared with sees it...
    expect((await views(executiveToken)).some((v) => v.id === id)).toBe(true);

    // ...and a colleague who was not named does not.
    const otherToken = await signIn(app, SEEDED.executiveB);
    expect((await views(otherToken)).some((v) => v.id === id)).toBe(false);

    // Un-sharing takes it away again. The whole list is sent on every save, so
    // an empty list is the only way the editor can say "nobody".
    const unshared = await request(app)
      .put(`/api/views/leads/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ sharedWith: [] });
    expect(unshared.status).toBe(200);
    expect((await views(executiveToken)).some((v) => v.id === id)).toBe(false);

    await request(app).delete(`/api/views/leads/${id}`).set('Authorization', `Bearer ${adminToken}`);
  });

  it('lets somebody open a view shared with them', async () => {
    const created = await request(app)
      .post('/api/views/leads')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `Openable ${Date.now()}`,
        columns: ['full_name'],
        filter: { logic: 'AND', conditions: [] },
        sharedWith: [executiveId],
      });
    const id = created.body.id as string;

    /*
      Being listed is not the same as being able to load it. The list query and
      the one `recordService` uses to resolve `?view=` are different statements,
      and only one of them used to know about shares — so a shared view
      appeared in the switcher and answered 400 when picked.
    */
    const rows = await request(app)
      .get(`/api/records/leads?view=${id}&pageSize=1`)
      .set('Authorization', `Bearer ${executiveToken}`);
    expect(rows.status).toBe(200);

    await request(app).delete(`/api/views/leads/${id}`).set('Authorization', `Bearer ${adminToken}`);
  });
});
