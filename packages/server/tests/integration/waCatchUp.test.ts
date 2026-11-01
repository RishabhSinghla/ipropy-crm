/** A message OpenWA has and the CRM does not is fetched once; one the CRM already holds is not stored twice. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { invalidate as reloadIntegrations, saveIntegration } from '../../src/core/settings/integrations.js';
import { OPENWA_PROVIDER, __resetOpenWaCaches } from '../../src/integrations/whatsapp/business/openwa.js';
import { catchUpNumber } from '../../src/integrations/whatsapp/business/waCatchUp.js';
import { receiveInbound } from '../../src/integrations/whatsapp/business/inbound.js';
import { startFakeOpenWa, type FakeOpenWa } from '../fakes/fakeOpenWa.js';

const stamp = Date.now();
const phone = (k: number): string => `91${String(stamp).slice(-6)}${k}00`;
let fake: FakeOpenWa;
let numberId = '';
const wasActive: string[] = [];
const ids = [1, 2, 3].map((k) => `3EB0CATCH${k}X${stamp}`);
const row = (k: number) => ({
  id: `internal-${k}`, waMessageId: ids[k - 1], chatId: `${phone(k)}@c.us`, from: `${phone(k)}@c.us`, to: '919800000001@c.us',
  body: `missed ${k}`, type: 'chat', direction: 'incoming', timestamp: Math.floor(Date.now() / 1000) - 600, metadata: {},
});
const count = async (): Promise<number> => Number((await db.queryOne<{ n: string }>(
  `SELECT COUNT(*) AS n FROM ipy_message WHERE number_id = $1 AND direction = 'inbound'`, [numberId]))?.n ?? 0);

beforeAll(async () => {
  fake = await startFakeOpenWa({ sessionName: `catch-${stamp}` });
  const active = await db.query<{ provider: string }>(`SELECT provider FROM ipy_integration WHERE provider LIKE 'whatsapp\\_%' AND is_active`);
  wasActive.push(...active.rows.map((r) => r.provider));
  await db.query(`UPDATE ipy_integration SET is_active = false WHERE provider LIKE 'whatsapp\\_%'`);
  await saveIntegration(OPENWA_PROVIDER, {
    config: { baseUrl: fake.baseUrl, sessionName: fake.sessionName }, credentials: { apiKey: fake.apiKey, webhookSecret: 'catch-up-secret-1234567' }, isActive: true,
  });
  await reloadIntegrations(); __resetOpenWaCaches();
  numberId = (await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_wa_number (session_name, session_id, status) VALUES ($1, $2, 'ready') RETURNING id`, [fake.sessionName, fake.sessionId]))!.id;
  fake.stored = [row(1), row(2), row(3)];
  // message 1 already arrived live
  await receiveInbound(OPENWA_PROVIDER, { providerMessageId: ids[0], from: phone(1), to: null, type: 'text', text: 'missed 1', media: null, sentAt: new Date(), profileName: null }, numberId);
});

afterAll(async () => {
  await fake.close();
  await db.query(`DELETE FROM ipy_message WHERE number_id = $1`, [numberId]);
  await db.query(`DELETE FROM ipy_conversation WHERE handle LIKE $1 AND NOT EXISTS (SELECT 1 FROM ipy_message m WHERE m.conversation_id = ipy_conversation.id)`, [`%${String(stamp).slice(-6)}%`]);
  await db.query(`DELETE FROM ipy_wa_webhook_event WHERE provider = $1 AND event_key LIKE $2`, [OPENWA_PROVIDER, `%${stamp}%`]);
  await db.query(`DELETE FROM ipy_wa_number WHERE id = $1`, [numberId]);
  await db.query(`UPDATE ipy_integration SET is_active = false WHERE provider = $1`, [OPENWA_PROVIDER]);
  for (const p of wasActive) if (p !== OPENWA_PROVIDER) await db.query(`UPDATE ipy_integration SET is_active = true WHERE provider = $1`, [p]);
  await reloadIntegrations();
});

describe('catching up a number', () => {
  it('a dry run counts but stores nothing', async () => {
    const r = await catchUpNumber(numberId, { dryRun: true });
    expect(r).toMatchObject({ fetched: 3, skipped: 0 });
    expect(await count()).toBe(1);
  });
  it('stores only what was missing', async () => {
    const r = await catchUpNumber(numberId);
    expect(r).toMatchObject({ fetched: 3, stored: 2, alreadyHad: 1 });
    expect(await count()).toBe(3);
  });
  it('is harmless to run again', async () => {
    const r = await catchUpNumber(numberId);
    expect(r).toMatchObject({ stored: 0, alreadyHad: 3 });
    expect(await count()).toBe(3);
  });
});
