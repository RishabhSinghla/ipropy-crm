/**
 * The view switcher ships with four views, and editing one is personal.
 *
 * "All Leads", "My Leads", "Unread Leads" and "Favourite Leads" are one row
 * each, read by the whole team (142 and 145 added the last two). Making
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

describe('the built-in views', () => {
  it('are what the switcher opens with', async () => {
    const list = await views(adminToken);
    const builtIn = list.filter((v) => v.isSystem).map((v) => v.name).sort();
    expect(builtIn).toEqual(['All Leads', 'Favourite Leads', 'My Leads', 'Unread Leads']);
  });

  it('count what each one would actually list', async () => {
    /*
      The switcher prints a number beside every view, and each is a separate
      count run through the same filter the view carries. A view whose count
      throws must leave the number off rather than take the whole switcher
      down with it, so the contract is: present and numeric, or absent.
    */
    const res = await request(app)
      .get('/api/views/leads?withCounts=true')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const counted = (res.body as { name: string; count?: number }[])
      .filter((v) => ['All Leads', 'My Leads', 'Unread Leads', 'Favourite Leads'].includes(v.name));
    expect(counted).toHaveLength(4);
    for (const v of counted) {
      expect(typeof v.count, `${v.name} has no count`).toBe('number');
      expect(v.count).toBeGreaterThanOrEqual(0);
    }

    // "All Leads" carries no filter, so nothing narrower can out-count it.
    const all = counted.find((v) => v.name === 'All Leads')!.count!;
    for (const v of counted) expect(v.count!).toBeLessThanOrEqual(all);
  });

  it('filter Unread Leads to records this person has never opened', async () => {
    /*
      `unread` is a system filter field with no column behind it — it reads the
      module watermark and the recently-viewed table. Opening a record has to
      take it out of the list, which is the half a filter test on its own
      cannot see.
    */
    const unread = (await views(adminToken)).find((v) => v.name === 'Unread Leads')!;
    const listed = async (): Promise<{ total: number; firstId?: string }> => {
      const res = await request(app)
        .get(`/api/records/leads?view=${unread.id}&pageSize=1`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      return { total: res.body.total as number, firstId: res.body.rows[0]?.id as string | undefined };
    };

    const before = await listed();
    if (!before.firstId) return; // nothing unread for this user; the operator still ran

    await request(app)
      .get(`/api/records/leads/${before.firstId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const after = await listed();
    expect(after.total).toBe(before.total - 1);
    expect(after.firstId).not.toBe(before.firstId);
  });

  it('cannot be deleted by anyone, administrator included', async () => {
    const all = (await views(adminToken)).find((v) => v.name === 'All Leads')!;
    const res = await request(app)
      .delete(`/api/views/leads/${all.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(403);

    // Still there, and still one of four.
    expect((await views(adminToken)).filter((v) => v.isSystem)).toHaveLength(4);
  });

  it('put a starred record into Favourite Leads and an unstarred one out', async () => {
    /*
      `favourite` is a system filter field over `ipy_starred`, so this view is
      per-person the way My Leads is. Asserted through the star endpoint rather
      than by writing the row, because the two disagreeing is the only way this
      breaks.
    */
    const fav = (await views(adminToken)).find((v) => v.name === 'Favourite Leads')!;
    const total = async (): Promise<number> => {
      const res = await request(app)
        .get(`/api/records/leads?view=${fav.id}&pageSize=1`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      return res.body.total as number;
    };

    const any = await request(app)
      .get('/api/records/leads?pageSize=1')
      .set('Authorization', `Bearer ${adminToken}`);
    const id = any.body.rows[0]?.id as string | undefined;
    if (!id) return;

    const before = await total();
    await request(app).post(`/api/records/leads/${id}/star`).set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(await total()).toBe(before + 1);

    // And it is one person's star, not the team's.
    const theirs = (await views(executiveToken)).find((v) => v.name === 'Favourite Leads')!;
    const other = await request(app)
      .get(`/api/records/leads?view=${theirs.id}&pageSize=1`)
      .set('Authorization', `Bearer ${executiveToken}`);
    expect(other.body.total).toBe(0);

    // Un-starring is the same POST with `starred: false`, not a DELETE — there
    // is no DELETE route, and calling one leaves the star in place while the
    // request quietly 404s.
    await request(app)
      .post(`/api/records/leads/${id}/star`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ starred: false })
      .expect(200);
    expect(await total()).toBe(before);
  });

  it('refuse a new view named after one of them', async () => {
    /*
      The other half of migration 144. That migration deletes the duplicates
      that exist; without this, anybody could make the next one and the
      switcher would show two identical lines again — which is the report that
      has now come in three times.
    */
    const res = await request(app)
      .post('/api/views/leads')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'My Leads', columns: [], filter: { logic: 'AND', conditions: [] } });
    expect(res.status).toBe(400);
    expect(String(res.body.message ?? '')).toMatch(/built-in/i);

    // Case is not a loophole: "my leads" reads identically in the switcher.
    const lower = await request(app)
      .post('/api/views/leads')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'my leads', columns: [], filter: { logic: 'AND', conditions: [] } });
    expect(lower.status).toBe(400);

    expect((await views(adminToken)).filter((v) => v.name.toLowerCase() === 'my leads')).toHaveLength(1);
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
