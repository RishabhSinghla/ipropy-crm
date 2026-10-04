/**
 * "Show me every record that is still mostly empty", and the reminder that goes
 * to whoever owns one.
 *
 * **4 October 2026, the owner:** *"i am pushing my team/agents that, they are
 * fill the form fields maximum … but alls are slacker … can you make an option
 * for that they are bound to filled maximum or all the fields in leads/inventory
 * module, or you can pushing hem time to time from crm/system."*
 *
 * **This suite exists because a unit test cannot catch what goes wrong here.**
 * `strengthPercentExpr` builds one CASE per answerable field into a string, so
 * typecheck sees nothing and a mocked `db.query` accepts any statement at all —
 * which is how the WhatsApp overview once shipped a column that had never
 * existed and answered 500 on a real database. What is asserted is first that
 * Postgres accepts the statement, and then that the number means what the bar on
 * screen means.
 *
 * **And the guard this had to get past.** The nudge does nothing until a target
 * is set, which is the right default and also means every test would otherwise
 * trip over the refusal and prove nothing beyond it. So this suite sets the
 * target itself and puts it back afterwards — the rule this repo wrote down after
 * every WhatsApp send died on a line no test had ever reached.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { signIn } from './fixtures.js';
import {
  countThinRecords, MIN_STRENGTH_SETTING, minProfileStrength, nudgeThinRecords, nudgeWording,
  resetNudgeDay, thinRecordsLink,
} from '../../src/core/quality/profileStrength.js';

const MARK = `zzstrength${Date.now()}`;
const THIN = `${MARK} Name And Number Only`;

let app: ReturnType<typeof createApp>;
let token: string;
let adminId: string;
const ids: string[] = [];

beforeAll(async () => {
  app = createApp();
  token = await signIn(app, 'admin@ipropy.com');
  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  expect(me.status, `GET /api/auth/me said ${me.status}: ${me.text}`).toBe(200);
  adminId = me.body.id as string;

  const stamp = String(Date.now()).slice(-6);
  // A name and a number and nothing else — which is exactly the record the owner
  // is complaining about, and exactly the one a rep must still be allowed to
  // create mid-call.
  const res = await request(app)
    .post('/api/records/leads')
    .set('Authorization', `Bearer ${token}`)
    .send({ full_name: THIN, country_code: '91', mobile: `98${stamp}44`, owner_id: adminId });
  expect(res.status, res.text).toBe(201);
  ids.push(res.body.id as string);
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_notification WHERE title = 'Some of your records need filling in'`);
  await db.query(`DELETE FROM ipy_record WHERE label LIKE $1`, [`${MARK}%`]);
  await db.query(`UPDATE ipy_setting SET value = '0'::jsonb WHERE key = $1`, [MIN_STRENGTH_SETTING]);
  resetNudgeDay();
});

async function setTarget(target: number): Promise<void> {
  await db.query(`UPDATE ipy_setting SET value = $2::jsonb WHERE key = $1`, [MIN_STRENGTH_SETTING, String(target)]);
}

describe('profile strength as a number anybody can filter on', () => {
  it('answers the list, and a thin record is under a high bar', async () => {
    const res = await request(app)
      .post('/api/records/leads/search')
      .set('Authorization', `Bearer ${token}`)
      .send({
        pageSize: 50,
        search: MARK,
        filter: { logic: 'AND', conditions: [{ field: 'profile_strength', operator: 'less_than', value: 90 }] },
      });
    expect(res.status, res.text).toBe(200);
    expect((res.body.rows as { label: string }[]).map((r) => r.label)).toContain(THIN);
  });

  it('and is above zero, because a name and a number are answers', async () => {
    const res = await request(app)
      .post('/api/records/leads/search')
      .set('Authorization', `Bearer ${token}`)
      .send({
        pageSize: 50,
        search: MARK,
        filter: { logic: 'AND', conditions: [{ field: 'profile_strength', operator: 'greater_than', value: 0 }] },
      });
    expect(res.status, res.text).toBe(200);
    expect((res.body.rows as { label: string }[]).map((r) => r.label)).toContain(THIN);
  });

  it('sorts by it as well as filters on it, which is what "weakest first" needs', async () => {
    const res = await request(app)
      .post('/api/records/leads/search')
      .set('Authorization', `Bearer ${token}`)
      .send({ pageSize: 50, search: MARK, sortBy: 'profile_strength', sortDir: 'asc' });
    expect(res.status, res.text).toBe(200);
  });
});

describe('the target', () => {
  it('reads as off when nobody has set one', async () => {
    await setTarget(0);
    expect(await minProfileStrength()).toBe(0);
    expect(await countThinRecords(0)).toEqual([]);
  });

  it('is clamped, so a mistyped row cannot mark the whole business thin for ever', async () => {
    await setTarget(400);
    expect(await minProfileStrength()).toBe(100);
  });

  it('counts each person their own records, and nobody else theirs', async () => {
    await setTarget(90);
    const counts = await countThinRecords(90);
    const mine = counts.find((row) => row.module === 'leads' && row.ownerId === adminId);
    expect(mine, 'the admin owns a thin lead and should be counted').toBeTruthy();
    expect(mine!.count).toBeGreaterThan(0);
    // Every row names somebody. A nudge needs a person to nudge.
    for (const row of counts) expect(row.ownerId).toBeTruthy();
  });
});

describe('the nudge itself', () => {
  it('says nothing at all while no target is set', async () => {
    await setTarget(0);
    resetNudgeDay();
    expect(await nudgeThinRecords(new Date('2026-10-05T09:30:00'))).toEqual({ sent: 0 });
  });

  it('writes one notification per person, not one per record', async () => {
    await setTarget(90);
    resetNudgeDay();
    const result = await nudgeThinRecords(new Date('2026-10-05T09:30:00'));
    expect(result.sent).toBeGreaterThan(0);

    const rows = await db.query<{ count: number; link: string | null }>(
      `SELECT COUNT(*)::int AS count, MIN(link) AS link FROM ipy_notification
        WHERE user_id = $1 AND title = 'Some of your records need filling in'`,
      [adminId],
    );
    expect(rows.rows[0]!.count).toBe(1);
    // The link is the list, pre-filtered — not a record, and not a new screen.
    expect(rows.rows[0]!.link).toContain('profile_strength');
  });

  it('does not send a second copy the same day, however often the tick runs', async () => {
    await setTarget(90);
    expect(await nudgeThinRecords(new Date('2026-10-05T09:45:00'))).toEqual({ sent: 0 });
  });

  it('keeps quiet outside the morning, so nobody is buzzed at midnight', async () => {
    await setTarget(90);
    resetNudgeDay();
    expect(await nudgeThinRecords(new Date('2026-10-06T23:30:00'))).toEqual({ sent: 0 });
  });
});

describe('what the nudge says and where it points', () => {
  it('reads as a sentence, biggest first', () => {
    const wording = nudgeWording([
      { module: 'properties', moduleLabel: 'Inventories', ownerId: 'u', count: 2 },
      { module: 'leads', moduleLabel: 'Contacts', ownerId: 'u', count: 9 },
    ], 60);
    expect(wording).toBe('9 contacts and 2 inventories of yours are under 60% complete.');
  });

  it('says "is" for exactly one record, because "1 contacts are" is wrong', () => {
    expect(nudgeWording([{ module: 'leads', moduleLabel: 'Contacts', ownerId: 'u', count: 1 }], 60))
      .toBe('1 contacts of yours is under 60% complete.');
  });

  it('points at that person own records, weakest first', () => {
    const link = thinRecordsLink('leads', 60);
    expect(link.startsWith('/leads?filter=')).toBe(true);
    expect(link).toContain('sort=profile_strength');
    expect(link).toContain('dir=asc');
    // `is_me`, not an id: one link, and each person sees only their own.
    expect(decodeURIComponent(link)).toContain('is_me');
  });
});
