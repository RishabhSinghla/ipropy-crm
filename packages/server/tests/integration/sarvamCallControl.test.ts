import { recordConsent } from '../../src/core/consent/index.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { adminContext, authUser, leadInput, SEEDED, signIn, adminToken } from './fixtures.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { tickSarvamQueue } from '../../src/integrations/voiceagent/queue.js';

const { dial } = vi.hoisted(() => ({ dial: vi.fn() }));
vi.mock('../../src/integrations/voiceagent/sarvam.js', async (original) => ({
  ...await original<typeof import('../../src/integrations/voiceagent/sarvam.js')>(), placeAgentCall: dial,
}));
let app: ReturnType<typeof createApp>;
let admin = '';
let agent = '';
let ids: string[] = [];
let seq = 0;
const stamp = Date.now();
const post = (path: string, body = {}) => request(app).post(`/api/telephony/${path}`).set('Authorization', `Bearer ${admin}`).send(body);
async function create(): Promise<string> {
  const res = await post('sarvam-queues', { module: 'leads', ids });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id;
}
beforeAll(async () => {
  app = createApp(); admin = await adminToken(app); agent = await signIn(app, SEEDED.executiveA);
  const ctx = await adminContext();
  for (let i=0; i<2; i++) ids.push((await recordService.createRecord(ctx, 'leads', leadInput({ full_name: `Sarvam queue ${stamp} ${i}` }))).id);
});
afterEach(() => { vi.useRealTimers(); });
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-18T06:00:00Z'));
  await db.query('DELETE FROM ipy_sarvam_queue');
  await db.query('DELETE FROM ipy_sarvam_batch');
  dial.mockReset();
  dial.mockImplementation(async (input: { recordId: string; recordModule: string; userId: string; toNumber: string; batchId: string }) => {
    const attemptId = `queue-test-${stamp}-${++seq}`;
    await db.query(`INSERT INTO ipy_call(direction,from_number,to_number,status,provider,provider_call_id,source,record_id,record_module,user_id,sarvam_batch_id)
      VALUES ('outbound','+919999999999',$1,'queued','sarvam_voice',$2,'sarvam',$3,$4,$5,$6)`, [input.toNumber,attemptId,input.recordId,input.recordModule,input.userId,input.batchId]);
    return { ok: true, attemptId };
  });
});

describe('saved Sarvam call control', () => {
  it('saves a paused queue, starts once, and stops remaining dials while the submitted call finishes', async () => {
    const id = await create();
    await tickSarvamQueue(); expect(dial).not.toHaveBeenCalled();
    expect((await post(`sarvam-queues/${id}/resume`)).status).toBe(200);
    await Promise.all([tickSarvamQueue(), tickSarvamQueue()]); expect(dial).toHaveBeenCalledTimes(1);
    expect((await post(`sarvam-queues/${id}/pause`)).status).toBe(200);
    await db.query(`UPDATE ipy_call SET status='completed' WHERE provider_call_id=$1`, [`queue-test-${stamp}-${seq}`]);
    await tickSarvamQueue(); expect(dial).toHaveBeenCalledTimes(1);
    const saved = await request(app).get('/api/telephony/sarvam-control').set('Authorization', `Bearer ${admin}`);
    expect(saved.body.items.filter((i: { status: string }) => i.status === 'pending')).toHaveLength(1);
    expect(saved.body.items.filter((i: { status: string }) => i.status === 'completed')).toHaveLength(1);
    expect(saved.body.totals.attempted).toBeGreaterThan(0);
    expect(saved.body.batches[0].attempt_count).toBe(1);
    expect(saved.body.calls.find((c: { batch_id: string }) => c.batch_id === id)).toBeTruthy();
    await post(`sarvam-queues/${id}/resume`); await tickSarvamQueue(); expect(dial).toHaveBeenCalledTimes(2);
  });
  it('never automatically redials an ambiguous provider response, including after another tick', async () => {
    dial.mockResolvedValue({ ok: false, uncertain: true, message: 'Network timeout' });
    const id = await create(); await post(`sarvam-queues/${id}/resume`);
    await tickSarvamQueue(); await tickSarvamQueue(); expect(dial).toHaveBeenCalledTimes(1);
    expect((await post(`sarvam-queues/${id}/resume`)).status).toBe(400);
    await post(`sarvam-queues/${id}/retry`);
    expect((await db.queryOne<{ status: string }>(`SELECT status FROM ipy_sarvam_queue WHERE batch_id=$1 AND position=0`,[id]))?.status).toBe('unknown');
  });
  it('only prepares unsuccessful calls for retry and leaves successful and uncalled contacts alone', async () => {
    const id = await create();
    await db.query(`UPDATE ipy_sarvam_queue SET status=CASE position WHEN 0 THEN 'completed' ELSE 'no_answer' END WHERE batch_id=$1`,[id]);
    await post(`sarvam-queues/${id}/retry`);
    const rows = await db.query<{ status: string }>('SELECT status FROM ipy_sarvam_queue WHERE batch_id=$1 ORDER BY position',[id]);
    expect(rows.rows.map((r) => r.status)).toEqual(['completed','pending']);
    expect(dial).not.toHaveBeenCalled();
  });
  it('restricts queue visibility and controls to its owner and admins', async () => {
    const id = await create();
    const user = await authUser(SEEDED.executiveA);
    const listed = await request(app).get('/api/telephony/sarvam-control').set('Authorization', `Bearer ${agent}`);
    expect(listed.status).toBe(200); expect(listed.body.batches.every((b: { user_id: string }) => b.user_id === user.id)).toBe(true);
    const stop = await request(app).post(`/api/telephony/sarvam-queues/${id}/pause`).set('Authorization', `Bearer ${agent}`).send({});
    expect(stop.status).toBe(403);
  });
  it('pauses a missing callback and accepts a late confirmed result without automatically resuming', async () => {
    const id = await create(); await post(`sarvam-queues/${id}/resume`); await tickSarvamQueue();
    await db.query(`UPDATE ipy_sarvam_queue SET updated_at=now()-interval '16 minutes' WHERE batch_id=$1 AND status='waiting'`, [id]);
    await tickSarvamQueue(); expect(dial).toHaveBeenCalledTimes(1);
    expect((await db.queryOne<{ status: string }>('SELECT status FROM ipy_sarvam_batch WHERE id=$1',[id]))?.status).toBe('paused');
    await db.query(`UPDATE ipy_call SET status='completed' WHERE provider_call_id=$1`, [`queue-test-${stamp}-${seq}`]);
    await tickSarvamQueue(); expect(dial).toHaveBeenCalledTimes(1);
    expect((await db.queryOne<{ status: string }>('SELECT status FROM ipy_sarvam_queue WHERE batch_id=$1 AND position=0',[id]))?.status).toBe('completed');
  });
  it('keeps the remaining queue saved outside calling hours and resumes in the next window', async () => {
    const id = await create(); await post(`sarvam-queues/${id}/resume`);
    vi.setSystemTime(new Date('2026-10-18T15:00:00Z'));
    await tickSarvamQueue(); expect(dial).not.toHaveBeenCalled();
    expect((await db.queryOne<{ status: string }>('SELECT status FROM ipy_sarvam_batch WHERE id=$1',[id]))?.status).toBe('running');
    vi.setSystemTime(new Date('2026-10-19T04:30:00Z'));
    await tickSarvamQueue(); expect(dial).toHaveBeenCalledTimes(1);
  });
  it('rechecks do-not-call before dispatch'  , async () => {
    const id = await create(); await post(`sarvam-queues/${id}/resume`);
    const queued = await db.queryOne<{ phone: string }>('SELECT phone FROM ipy_sarvam_queue WHERE batch_id=$1 AND position=0',[id]);
    await recordConsent({ handle: queued!.phone, channel: 'call', action: 'opt_out' });
    try { await tickSarvamQueue(); expect(dial).not.toHaveBeenCalled(); }
    finally { await recordConsent({ handle: queued!.phone, channel: 'call', action: 'opt_in' }); }
  });
});
