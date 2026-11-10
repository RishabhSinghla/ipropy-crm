import { recordConsent } from '../../src/core/consent/index.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { adminContext, authUser, leadInput, SEEDED, signIn, adminToken } from './fixtures.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { saveIntegration } from '../../src/core/settings/integrations.js';
import { tickSarvamQueue } from '../../src/integrations/voiceagent/queue.js';

const { dial } = vi.hoisted(() => ({ dial: vi.fn() }));
vi.mock('../../src/integrations/voiceagent/sarvam.js', async (original) => ({
  ...await original<typeof import('../../src/integrations/voiceagent/sarvam.js')>(), placeAgentCall: dial,
}));
let app: ReturnType<typeof createApp>;
let admin = '';
let agent = '';
let ids: string[] = [];
const setCalls = (n: number) => saveIntegration('sarvam_voice', { isActive: true, config: { callsAtATime: String(n) } });
let seq = 0;
const stamp = Date.now();
const post = (path: string, body = {}) => request(app).post(`/api/telephony/${path}`).set('Authorization', `Bearer ${admin}`).send(body);
async function create(): Promise<string> {
  const res = await post('sarvam-queues', { module: 'leads', ids });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id;
}
beforeAll(async () => {
  await setCalls(3);
  app = createApp(); admin = await adminToken(app); agent = await signIn(app, SEEDED.executiveA);
  const ctx = await adminContext();
  for (let i=0; i<5; i++) ids.push((await recordService.createRecord(ctx, 'leads', leadInput({ full_name: `Sarvam queue ${stamp} ${i}` }))).id);
});
afterEach(() => { vi.useRealTimers(); });
afterAll(async () => { await saveIntegration('sarvam_voice', { isActive: false, config: { batchSize: '25' } }); });
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


const statusCount = async (status: string) => (await db.queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM ipy_sarvam_queue WHERE status=$1`, [status]))!.n;
const finish = (n: number) => db.query(`UPDATE ipy_call SET status='completed' WHERE provider_call_id IN (SELECT attempt_id FROM ipy_sarvam_queue WHERE status='waiting' ORDER BY position LIMIT ${n})`);

describe('parallel Sarvam calls', () => {
  it('puts 3 calls in flight at once and never more than the setting', async () => {
    await setCalls(3);
    const id = await create(); await post(`sarvam-queues/${id}/resume`);
    await tickSarvamQueue(); expect(dial).toHaveBeenCalledTimes(3);
    await tickSarvamQueue(); await tickSarvamQueue(); expect(dial).toHaveBeenCalledTimes(3);
    expect(await statusCount('waiting')).toBe(3);
    await finish(1); await tickSarvamQueue(); expect(dial).toHaveBeenCalledTimes(4);
    expect(await statusCount('waiting')).toBe(3);
  });
  it('two ticks at the same moment still stay within the limit', async () => {
    await setCalls(2);
    const id = await create(); await post(`sarvam-queues/${id}/resume`);
    await Promise.all([tickSarvamQueue(), tickSarvamQueue(), tickSarvamQueue()]);
    expect(dial).toHaveBeenCalledTimes(2);
  });
  it('setting 1 rings one customer at a time, as before', async () => {
    await setCalls(1);
    const id = await create(); await post(`sarvam-queues/${id}/resume`);
    await tickSarvamQueue(); await tickSarvamQueue(); expect(dial).toHaveBeenCalledTimes(1);
    await finish(1); await tickSarvamQueue(); expect(dial).toHaveBeenCalledTimes(2);
  });
  it('never rings the same number twice at the same time', async () => {
    await setCalls(5);
    const id = await create(); await post(`sarvam-queues/${id}/resume`);
    await db.query(`UPDATE ipy_sarvam_queue SET phone=(SELECT phone FROM ipy_sarvam_queue WHERE batch_id=$1 AND position=0) WHERE batch_id=$1 AND position=1`, [id]);
    await tickSarvamQueue();
    expect(dial).toHaveBeenCalledTimes(4);
    const numbers = dial.mock.calls.map((c) => c[0].toNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
    await finish(1); await tickSarvamQueue(); expect(dial).toHaveBeenCalledTimes(5);
  });
  it('one unknown call pauses its batch but the calls already in flight stay as they are', async () => {
    await setCalls(3);
    let n = 0;
    dial.mockImplementationOnce(async (input: { recordId: string; recordModule: string; userId: string; toNumber: string; batchId: string }) => {
      n++; const attemptId = `queue-test-${stamp}-${++seq}`;
      await db.query(`INSERT INTO ipy_call(direction,from_number,to_number,status,provider,provider_call_id,source,record_id,record_module,user_id,sarvam_batch_id)
        VALUES ('outbound','+919999999999',$1,'queued','sarvam_voice',$2,'sarvam',$3,$4,$5,$6)`, [input.toNumber,attemptId,input.recordId,input.recordModule,input.userId,input.batchId]);
      return { ok: true, attemptId };
    });
    dial.mockResolvedValueOnce({ ok: false, uncertain: true, message: 'Network timeout' });
    const id = await create(); await post(`sarvam-queues/${id}/resume`);
    await tickSarvamQueue();
    expect(n).toBe(1);
    expect(await statusCount('unknown')).toBe(1);
    expect((await db.queryOne<{ status: string }>('SELECT status FROM ipy_sarvam_batch WHERE id=$1',[id]))?.status).toBe('paused');
    const before = dial.mock.calls.length;
    await tickSarvamQueue(); expect(dial.mock.calls.length).toBe(before);
    expect(await statusCount('waiting')).toBe(2);
  });
  it('a Sarvam line-limit refusal keeps the contact and pauses with a clear message', async () => {
    await setCalls(3);
    dial.mockReset(); dial.mockResolvedValue({ ok: false, lineLimit: true, message: 'Sarvam says too many calls are live at once (429).' });
    const id = await create(); await post(`sarvam-queues/${id}/resume`);
    await tickSarvamQueue();
    const batch = await db.queryOne<{ status: string; message: string }>('SELECT status, message FROM ipy_sarvam_batch WHERE id=$1',[id]);
    expect(batch?.status).toBe('paused'); expect(batch?.message).toMatch(/too many calls/);
    expect(await statusCount('failed')).toBe(0);
    expect(await statusCount('pending')).toBe(5);
  });
  it('the batch is done only when nothing is pending or in flight', async () => {
    await setCalls(5);
    const id = await create(); await post(`sarvam-queues/${id}/resume`);
    await tickSarvamQueue();
    await finish(4); await tickSarvamQueue();
    expect((await db.queryOne<{ status: string }>('SELECT status FROM ipy_sarvam_batch WHERE id=$1',[id]))?.status).toBe('running');
    await finish(1); await tickSarvamQueue();
    expect((await db.queryOne<{ status: string }>('SELECT status FROM ipy_sarvam_batch WHERE id=$1',[id]))?.status).toBe('done');
  });
});
