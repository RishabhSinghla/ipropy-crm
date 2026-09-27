/**
 * "Who have I not rung for a month", and "show me everybody I marked Not
 * Interested."
 *
 * **27 September 2026, the owner** asked for a Call Disposition filter button
 * in the toolbar and for the queue to be sortable by the last call. Neither
 * could be asked at all before this: **a disposition is not a field on either
 * module** — it lives on `ipy_call`, one row per call — so the filter grammar
 * had no name for it.
 *
 * `last_call_at` and `last_call_disposition` are system fields in the query
 * builder now, which is what makes the list, a saved view, a dashboard widget
 * and the queue's sorting ask it the same way rather than four ways.
 *
 * **This suite exists because a unit test cannot catch what goes wrong here.**
 * The SQL is a string, so typecheck sees nothing, and a mocked `db.query`
 * accepts any statement at all — the WhatsApp overview shipped with a column
 * name that had never existed and answered 500 on a real database. What is
 * asserted here is first that Postgres accepts the statements, and then that
 * they say the right thing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { signIn } from './fixtures.js';

const MARK = `zzlastcall${Date.now()}`;
const RUNG_TODAY = `${MARK} Rung Today`;
const RUNG_LAST_WEEK = `${MARK} Rung Last Week`;
const NEVER_RUNG = `${MARK} Never Rung`;

let app: ReturnType<typeof createApp>;
let token: string;
const ids: Record<string, string> = {};

async function makeLead(name: string, mobile: string): Promise<string> {
  const res = await request(app)
    .post('/api/records/leads')
    .set('Authorization', `Bearer ${token}`)
    .send({ full_name: name, country_code: '91', mobile });
  if (res.status !== 201 && res.status !== 200) throw new Error(`could not create ${name}: ${res.status} ${res.text}`);
  return res.body.id as string;
}

beforeAll(async () => {
  app = createApp();
  token = await signIn(app, 'admin@ipropy.com');

  // Its own three leads with its own marker: this asserts on which of them
  // comes back and in what order, which is not a question to ask of whatever
  // the seed happened to leave behind.
  const stamp = String(Date.now()).slice(-6);
  ids.today = await makeLead(RUNG_TODAY, `98${stamp}01`);
  ids.lastWeek = await makeLead(RUNG_LAST_WEEK, `98${stamp}02`);
  ids.never = await makeLead(NEVER_RUNG, `98${stamp}03`);

  await db.query(
    `INSERT INTO ipy_call (direction, from_number, to_number, record_id, record_module, status, disposition, started_at)
     VALUES ('outbound', '1', '2', $1, 'leads', 'completed', 'Interested', now()),
            ('outbound', '1', '2', $2, 'leads', 'completed', 'Not Interested', now() - interval '7 days')`,
    [ids.today, ids.lastWeek],
  );
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_call WHERE record_id = ANY($1::uuid[])`, [Object.values(ids)]);
  await db.query(`DELETE FROM ipy_record WHERE label LIKE $1`, [`${MARK}%`]);
});

/** The three leads this suite made, in the order the list gave them back. */
async function listed(body: Record<string, unknown>): Promise<string[]> {
  const res = await request(app)
    .post('/api/records/leads/search')
    .set('Authorization', `Bearer ${token}`)
    .send({ pageSize: 100, search: MARK, ...body });
  expect(res.status, `the list answered ${res.status}: ${res.text}`).toBe(200);
  return (res.body.rows as { label: string }[]).map((row) => row.label);
}

describe('the last call, as ordinary filter grammar', () => {
  it('sorts by when somebody was last rung, longest ago first', async () => {
    const order = await listed({ sortBy: 'last_call_at', sortDir: 'asc' });
    expect(order.indexOf(RUNG_LAST_WEEK)).toBeLessThan(order.indexOf(RUNG_TODAY));
    // Never rung is not "rung a long time ago" — NULLS LAST keeps it out of the
    // way rather than at the head of a chase list.
    expect(order[order.length - 1]).toBe(NEVER_RUNG);
  });

  it('sorts the other way round too, which is the whole of A–Z / Z–A', async () => {
    const order = await listed({ sortBy: 'last_call_at', sortDir: 'desc' });
    expect(order.indexOf(RUNG_TODAY)).toBeLessThan(order.indexOf(RUNG_LAST_WEEK));
  });

  it('filters to how the last call went', async () => {
    expect(await listed({ filter: { logic: 'AND', conditions: [
      { field: 'last_call_disposition', operator: 'in', value: ['Not Interested'] },
    ] } })).toEqual([RUNG_LAST_WEEK]);
  });

  /*
    The newest call wins, not the first one found. A rep who rings back an
    unreachable number and gets through must not still read as Not Reachable.
  */
  it('reads the most recent call, not any call', async () => {
    await db.query(
      `INSERT INTO ipy_call (direction, from_number, to_number, record_id, record_module, status, disposition, started_at)
       VALUES ('outbound', '1', '2', $1, 'leads', 'completed', 'Site Visit Scheduled', now() + interval '1 minute')`,
      [ids.lastWeek],
    );
    expect(await listed({ filter: { logic: 'AND', conditions: [
      { field: 'last_call_disposition', operator: 'in', value: ['Site Visit Scheduled'] },
    ] } })).toEqual([RUNG_LAST_WEEK]);
  });

  it('finds the people nobody has rung at all', async () => {
    expect(await listed({ filter: { logic: 'AND', conditions: [
      { field: 'last_call_disposition', operator: 'is_empty' },
    ] } })).toEqual([NEVER_RUNG]);
  });

  /*
    Which fields count towards a record's strength is `isAnswerable` in
    `@ipropy/shared`, the same function the bar on screen asks. What matters
    here is that Postgres accepts the statement it builds — forty CASE
    expressions over both storage modes — and that the fuller record wins.
  */
  it('sorts by how much of a record is filled in', async () => {
    await request(app)
      .patch(`/api/records/leads/${ids.never}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'fuller@example.com', locality: 'Baner' });

    const fullestFirst = await listed({ sortBy: 'profile_strength', sortDir: 'desc' });
    expect(fullestFirst[0]).toBe(NEVER_RUNG);
    expect((await listed({ sortBy: 'profile_strength', sortDir: 'asc' }))[0]).not.toBe(NEVER_RUNG);
  });

  /*
    "Agent wise, A–Z" plainly means the person's name; `owner_id` is a uuid.
    The assertion here is only that the statement runs — who owns a lead the
    test just made is the assignment rules' business, not this suite's.
  */
  it('sorts by the agent without raising', async () => {
    expect((await listed({ sortBy: 'owner_id', sortDir: 'asc' })).length).toBe(3);
    expect((await listed({ sortBy: 'created_by', sortDir: 'desc' })).length).toBe(3);
    expect((await listed({ sortBy: 'modified_by', sortDir: 'asc' })).length).toBe(3);
  });
});
