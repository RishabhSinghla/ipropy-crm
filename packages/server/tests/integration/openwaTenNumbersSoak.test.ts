/**
 * Ten numbers at once. A pretend OpenWA delivers 30 customer messages to each of ten numbers, in parallel, then delivers
 * every one of them AGAIN (what OpenWA does when it retries after a restart). The CRM must end with exactly 300 messages,
 * each filed against the number that received it, with no slow request and no runaway memory.
 *
 * Limits written down by this test (see docs/OPENWA.md): p95 webhook latency under 1.5 s and under 120 MB of extra heap.
 */
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { invalidate as reloadIntegrations, saveIntegration } from '../../src/core/settings/integrations.js';
import { OPENWA_PROVIDER } from '../../src/integrations/whatsapp/business/openwa.js';

const SECRET = 'soak-webhook-secret-1234567890';
const stamp = Date.now();
const NUMBERS = 10;
const PER_NUMBER = 30;
const sessions = Array.from({ length: NUMBERS }, (_, i) => `soak-${stamp}-${i}`);
const phoneOf = (n: number, c: number): string => `91${String(stamp).slice(-5)}${n}${String(c).padStart(4, '0')}`;
let app: ReturnType<typeof createApp>;
let numberIds: string[] = [];
const wasActive: string[] = [];

function delivery(session: string, n: number, c: number) {
  const phone = phoneOf(n, c);
  const id = `3EB0SOAK${n}X${c}X${stamp}`;
  const body = JSON.stringify({
    event: 'message.received', timestamp: new Date().toISOString(), sessionId: session,
    idempotencyKey: `msg_${session}_${id}`, deliveryId: `dlv_${n}_${c}`,
    data: {
      id, from: `${phone}@c.us`, to: '919800000001@c.us', chatId: `${phone}@c.us`, body: `soak ${n}/${c}`, type: 'chat',
      timestamp: Math.floor(Date.now() / 1000), isGroup: false, kind: 'individual', fromMe: false, contact: { pushName: `Soak ${n}-${c}` },
    },
  });
  const sig = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
  return { phone, body, sig };
}

async function post(d: { body: string; sig: string }): Promise<number> {
  const t0 = performance.now();
  const res = await request(app).post('/api/webhooks/whatsapp/openwa')
    .set('content-type', 'application/json').set('x-openwa-signature', d.sig).send(d.body);
  expect(res.status, `${res.status} ${res.text} ${JSON.stringify(res.body)}`).toBe(200);
  return performance.now() - t0;
}

async function inParallel<T>(items: T[], width: number, run: (t: T) => Promise<number>): Promise<number[]> {
  const times: number[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < items.length) times.push(await run(items[next++]));
  }));
  return times;
}

beforeAll(async () => {
  app = createApp();
  const active = await db.query<{ provider: string }>(`SELECT provider FROM ipy_integration WHERE provider LIKE 'whatsapp\\_%' AND is_active`);
  wasActive.push(...active.rows.map((r) => r.provider));
  await db.query(`UPDATE ipy_integration SET is_active = false WHERE provider LIKE 'whatsapp\\_%'`);
  await saveIntegration(OPENWA_PROVIDER, {
    config: { baseUrl: 'http://127.0.0.1:9', sessionName: sessions[0] },
    credentials: { apiKey: 'unused-in-this-test', webhookSecret: SECRET },
    isActive: true,
  });
  await reloadIntegrations();
  for (const s of sessions) {
    const row = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_wa_number (session_name, session_id, status) VALUES ($1, $1, 'ready') RETURNING id`, [s]);
    numberIds.push(row!.id);
  }
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_message WHERE number_id = ANY($1::uuid[])`, [numberIds]);
  await db.query(`DELETE FROM ipy_conversation WHERE handle LIKE $1 AND NOT EXISTS (SELECT 1 FROM ipy_message m WHERE m.conversation_id = ipy_conversation.id)`, [`%${String(stamp).slice(-5)}%`]);
  await db.query(`DELETE FROM ipy_wa_webhook_event WHERE provider = $1 AND event_key LIKE $2`, [OPENWA_PROVIDER, `%${stamp}%`]);
  await db.query(`DELETE FROM ipy_wa_number WHERE id = ANY($1::uuid[])`, [numberIds]);
  await db.query(`UPDATE ipy_integration SET is_active = false WHERE provider = $1`, [OPENWA_PROVIDER]);
  for (const p of wasActive) if (p !== OPENWA_PROVIDER) await db.query(`UPDATE ipy_integration SET is_active = true WHERE provider = $1`, [p]);
  await reloadIntegrations();
});

describe('ten numbers, each hit with 30 customers, then everything delivered twice', () => {
  it('stores each message exactly once on the right number, quickly, without growing memory', async () => {
    const all = sessions.flatMap((s, n) => Array.from({ length: PER_NUMBER }, (_, c) => ({ s, n, c, ...delivery(s, n, c) })));
    const heapBefore = process.memoryUsage().heapUsed;

    const first = await inParallel(all, 20, (d) => post(d));
    const retry = await inParallel(all, 20, (d) => post(d)); // OpenWA retrying the very same deliveries

    // The webhook answers 200 first and stores afterwards, so wait for the work itself and time it.
    const startedWaiting = performance.now();
    const countStored = async (): Promise<number> => Number((await db.queryOne<{ n: string }>(
      `SELECT COUNT(*) AS n FROM ipy_message WHERE number_id = ANY($1::uuid[]) AND direction = 'inbound'`, [numberIds]))?.n ?? 0);
    while ((await countStored()) < NUMBERS * PER_NUMBER && performance.now() - startedWaiting < 60_000) {
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 1500)); // a retry that slipped past the check would show up by now
    const drainSeconds = (performance.now() - startedWaiting) / 1000;

    const stored = await db.query<{ number_id: string; n: string }>(
      `SELECT number_id, COUNT(*) AS n FROM ipy_message WHERE number_id = ANY($1::uuid[]) AND direction = 'inbound' GROUP BY number_id`, [numberIds]);
    expect(stored.rows).toHaveLength(NUMBERS);
    for (const r of stored.rows) expect(Number(r.n)).toBe(PER_NUMBER);
    const dupes = await db.queryOne<{ n: string }>(
      `SELECT COUNT(*) AS n FROM (SELECT provider_message_id FROM ipy_message WHERE number_id = ANY($1::uuid[]) GROUP BY 1 HAVING COUNT(*) > 1) d`, [numberIds]);
    expect(Number(dupes?.n)).toBe(0);

    const times = [...first, ...retry].sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)];
    const heapGrowthMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;
    const line = `soak: ${times.length} deliveries, p50 ${times[Math.floor(times.length / 2)].toFixed(0)} ms, p95 ${p95.toFixed(0)} ms, max ${times[times.length - 1].toFixed(0)} ms, heap +${heapGrowthMb.toFixed(1)} MB, all stored ${drainSeconds.toFixed(1)} s after the last delivery`;
    if (process.env.SOAK_REPORT) (await import('node:fs')).appendFileSync(process.env.SOAK_REPORT, `${line}\n`);
    expect(drainSeconds).toBeLessThan(45);
    expect(p95).toBeLessThan(1500);
    expect(heapGrowthMb).toBeLessThan(120);
  }, 120_000);
});
