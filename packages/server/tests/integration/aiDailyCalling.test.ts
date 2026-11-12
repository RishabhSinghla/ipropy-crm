/**
 * Automatic daily AI calling, against a real database.
 *
 * The SQL here is all strings (the `ipy_ai_status` function, the four AI system fields, the run table's unique
 * index), so typecheck and a mocked `db.query` cannot see a wrong column. Nothing in this file rings anybody:
 * `readSarvamSettings` is stubbed so the run can start, and the queue worker (`tickSarvamQueue`) is never called.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { adminContext, adminToken, leadInput } from './fixtures.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { recordConsent } from '../../src/core/consent/index.js';
import { startAutoRun, tickAutoCalls, planAutoCalls } from '../../src/integrations/voiceagent/autoCalls.js';

vi.mock('../../src/integrations/voiceagent/sarvam.js', async (original) => ({
  ...await original<typeof import('../../src/integrations/voiceagent/sarvam.js')>(),
  readSarvamSettings: () => ({ settings: {} }),
}));

const MARK = `zzaidaily${Date.now()}`;
const stamp = String(Date.now()).slice(-6);
let app: ReturnType<typeof createApp>;
let token = '';
let adminId = '';
let viewId = '';
const ids: Record<string, string> = {};

const SATURDAY_11_10_IST = new Date('2026-11-14T05:40:00Z');
const lead = async (key: string, mobile: string, extra: Record<string, unknown> = {}): Promise<void> => {
  const ctx = await adminContext();
  ids[key] = (await recordService.createRecord(ctx, 'leads', leadInput({ full_name: `${MARK} ${key}`, mobile, ...extra }))).id;
};
const search = async (filter: unknown): Promise<string[]> => {
  const res = await request(app).post('/api/records/leads/search').set('Authorization', `Bearer ${token}`)
    .send({ pageSize: 100, search: MARK, filter });
  expect(res.status, res.text).toBe(200);
  return (res.body.rows as { label: string }[]).map((r) => r.label.replace(`${MARK} `, '')).sort();
};

beforeAll(async () => {
  app = createApp();
  token = await adminToken(app);
  adminId = (await db.queryOne<{ id: string }>(`SELECT id FROM ipy_user WHERE email = 'admin@ipropy.com'`))!.id;
  await lead('talked', `98${stamp}11`);
  await lead('noanswer', `98${stamp}12`);
  await lead('fresh', `98${stamp}13`);
  await lead('twin', `98${stamp}13`.replace(/3$/, '4'));
  await lead('dnc', `98${stamp}15`);
  // Opted out of calls: the same refusal the queue and the call button already honour.
  await recordConsent({ handle: `+9198${stamp}15`, channel: 'call', action: 'opt_out', source: 'test', recordId: ids.dnc, messageText: 'test' });
  const ins = (key: string, status: string, disposition: string | null, outcome: string | null, ago: string) => db.query(
    `INSERT INTO ipy_call (direction, from_number, to_number, record_id, record_module, status, disposition, source, provider, provider_call_id, started_at, sarvam_meta)
     VALUES ('outbound','+910','+911',$1,'leads',$2,$3,'sarvam','sarvam_voice',$4, now() - $5::interval, $6::jsonb)`,
    [ids[key], status, disposition, `${MARK}-${key}`, ago, JSON.stringify(outcome ? { outcome } : {})]);
  await ins('talked', 'completed', 'Interested', 'conversation', '3 days');
  await ins('noanswer', 'no_answer', null, null, '2 days');
  const mod = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_module WHERE name = 'leads'`);
  viewId = (await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_view (module_id, name, is_public, filter) VALUES ($1,$2,true,$3::jsonb) RETURNING id`,
    [mod!.id, `${MARK} view`, JSON.stringify({ logic: 'AND', conditions: [{ field: 'full_name', operator: 'contains', value: MARK }] })]))!.id;
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_sarvam_queue WHERE record_id = ANY($1::uuid[])`, [Object.values(ids)]);
  await db.query(`DELETE FROM ipy_sarvam_batch WHERE origin = 'auto'`);
  await db.query(`DELETE FROM ipy_ai_call_run`);
  await db.query(`DELETE FROM ipy_call WHERE provider_call_id LIKE $1`, [`${MARK}%`]);
  await db.query(`DELETE FROM ipy_record WHERE label LIKE $1`, [`${MARK}%`]);
  await db.query(`DELETE FROM ipy_view WHERE name LIKE $1`, [`${MARK}%`]);
  await db.query(`UPDATE ipy_ai_call_schedule SET enabled = false, view_id = NULL, owner_user_id = NULL`);
});

beforeEach(async () => {
  await db.query(`DELETE FROM ipy_sarvam_queue WHERE record_id = ANY($1::uuid[])`, [Object.values(ids)]);
  await db.query(`DELETE FROM ipy_sarvam_batch WHERE origin = 'auto'`);
  await db.query(`DELETE FROM ipy_ai_call_run`);
  await db.query(`UPDATE ipy_ai_call_schedule SET enabled = false, view_id = NULL, owner_user_id = NULL`);
});
afterEach(() => { vi.useRealTimers(); });

describe('what the AI call status says', () => {
  it('reads each lead\'s status from its calls, the same way for filters and columns', async () => {
    expect(await search({ logic: 'AND', conditions: [{ field: 'ai_call_status', operator: 'in', value: ['interested'] }] })).toEqual(['talked']);
    expect(await search({ logic: 'AND', conditions: [{ field: 'ai_call_status', operator: 'in', value: ['no_answer'] }] })).toEqual(['noanswer']);
    expect(await search({ logic: 'AND', conditions: [{ field: 'ai_call_status', operator: 'in', value: ['never_called'] }] })).toEqual(['dnc', 'fresh', 'twin']);
    expect(await search({ logic: 'AND', conditions: [{ field: 'ai_attempts', operator: 'greater_than', value: 0 }] })).toEqual(['noanswer', 'talked']);
  });

  it('shows queued while a call is waiting in a queue', async () => {
    const batch = await db.queryOne<{ id: string }>(`INSERT INTO ipy_sarvam_batch(user_id, module, status, origin) VALUES ($1,'leads','paused','auto') RETURNING id`, [adminId]);
    await db.query(`INSERT INTO ipy_sarvam_queue(batch_id, record_id, label, phone, position) VALUES ($1,$2,'x','+910',0)`, [batch!.id, ids.fresh]);
    expect(await search({ logic: 'AND', conditions: [{ field: 'ai_call_status', operator: 'in', value: ['queued'] }] })).toEqual(['fresh']);
  });
});

describe('the daily run is off until somebody switches it on', () => {
  // Fake time only here: the sign-in token above must not be judged against a date days away.
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(SATURDAY_11_10_IST); });

  it('does nothing at all with the switches off, even at the start time on a chosen day', async () => {
    await tickAutoCalls(SATURDAY_11_10_IST);
    expect((await db.queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM ipy_ai_call_run`))!.n).toBe(0);
  });

  it('with no saved view picked, nobody is eligible', async () => {
    await db.query(`UPDATE ipy_ai_call_schedule SET enabled = true, owner_user_id = $1 WHERE module IN ('_master','leads')`, [adminId]);
    const plan = await planAutoCalls({ module: 'leads', asOf: SATURDAY_11_10_IST });
    expect(plan.problem).toMatch(/saved view/);
    expect(plan.picks).toHaveLength(0);
  });

  it('once on, starts ONE batch per module per day, however many times the tick fires (a redeploy)', async () => {
    await db.query(`UPDATE ipy_ai_call_schedule SET enabled = true, owner_user_id = $1 WHERE module IN ('_master','leads')`, [adminId]);
    await db.query(`UPDATE ipy_ai_call_schedule SET view_id = $1 WHERE module = 'leads'`, [viewId]);
    await recordConsent({ handle: '+91' + `98${stamp}12`, channel: 'call', action: 'opt_out', source: 'test', recordId: ids.noanswer, messageText: 'test' });
    await tickAutoCalls(SATURDAY_11_10_IST);
    await tickAutoCalls(SATURDAY_11_10_IST);
    const runs = await db.query(`SELECT * FROM ipy_ai_call_run WHERE module = 'leads'`);
    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0].status).toBe('running');
    const batches = await db.query(`SELECT * FROM ipy_sarvam_batch WHERE run_id = $1`, [runs.rows[0].id]);
    expect(batches.rows).toHaveLength(1);
    expect(batches.rows[0].origin).toBe('auto');
    const queued = (await db.query<{ record_id: string }>(`SELECT record_id FROM ipy_sarvam_queue WHERE batch_id = $1`, [batches.rows[0].id])).rows.map((r) => r.record_id);
    // fresh is called; twin has a different number so is called too; talked is resting; noanswer and dnc opted out.
    expect(queued.sort()).toEqual([ids.fresh, ids.twin].sort());
    expect(runs.rows[0].skipped).toMatchObject({ resting: 1, opted_out: 2 });
  });

  it('a hand-picked test run calls only the chosen records, within a hard limit, with the switches off', async () => {
    await db.query(`UPDATE ipy_ai_call_schedule SET owner_user_id = $1 WHERE module = '_master'`, [adminId]);
    const result = await startAutoRun({ module: 'leads', trigger: 'manual', limit: 1, onlyRecordIds: [ids.fresh, ids.twin, ids.dnc], startedBy: adminId });
    expect(result.status).toBe('running');
    expect(result.planned).toBe(1);
    const queued = await db.query(`SELECT record_id FROM ipy_sarvam_queue q JOIN ipy_sarvam_batch b ON b.id = q.batch_id WHERE b.run_id = $1`, [result.runId]);
    expect(queued.rows.map((r) => r.record_id)).toEqual([ids.fresh]);
  });

  it('never queues an opted-out number, even when picked by hand', async () => {
    const plan = await planAutoCalls({ module: 'leads', asOf: SATURDAY_11_10_IST, onlyRecordIds: [ids.dnc], limit: 5 });
    expect(plan.picks).toHaveLength(0);
    expect(plan.skippedCount.opted_out).toBe(1);
  });
});
