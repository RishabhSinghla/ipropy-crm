/**
 * The slow promotional drip against a real database and a pretend OpenWA: one message at a time, with the opt-out line,
 * only inside the window, never the same number twice, and it stops itself (and tells the admins) when something is wrong.
 * Nothing here talks to a real WhatsApp.
 */
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { recordConsent } from '../../src/core/consent/index.js';
import { invalidate as reloadIntegrations, saveIntegration } from '../../src/core/settings/integrations.js';
import { __resetOpenWaCaches, OPENWA_PROVIDER } from '../../src/integrations/whatsapp/business/openwa.js';
import { dripTick, readDrip, startDrip, stopDrip } from '../../src/integrations/whatsapp/business/drip.js';
import { currentCounts } from '../../src/integrations/whatsapp/business/openwaGuards.js';
import { DEFAULT_VARIANTS } from '../../src/integrations/whatsapp/business/dripRules.js';
import { SEEDED, adminContext, adminToken, leadInput, signIn } from './fixtures.js';
import { startFakeOpenWa, type FakeOpenWa } from '../fakes/fakeOpenWa.js';

// 12:00 and 22:00 India time on one day.
const NOON = new Date('2026-11-09T06:30:00Z');
const NIGHT = new Date('2026-11-09T16:30:00Z');

let app: ReturnType<typeof createApp>;
let fake: FakeOpenWa;
let admin = '';
let rep = '';
let adminId = '';
let numberId = '';
const previouslyActive: string[] = [];
const leads: { id: string; mobile: string }[] = [];
const dripIds: string[] = [];

async function newLead(name: string): Promise<{ id: string; mobile: string }> {
  const input = leadInput({ full_name: name, country_code: '+91' });
  const lead = await recordService.createRecord(await adminContext(), 'leads', input);
  const made = { id: lead.id, mobile: String(input.mobile) };
  leads.push(made);
  fake.onWhatsApp.set(`91${made.mobile}`, { pushName: name });
  return made;
}

async function newDrip(over: { capStart?: number; status?: string } = {}): Promise<string> {
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_wa_drip (name, variants, number_ids, status, cap_start, cap_max, started_by, next_send_at, approved_count)
     VALUES ('Test drip', $1::jsonb, ARRAY[$2]::uuid[], $3, $4, 40, $5, now() - interval '1 minute', 3) RETURNING id`,
    [JSON.stringify(DEFAULT_VARIANTS), numberId, over.status ?? 'running', over.capStart ?? 20, adminId],
  );
  dripIds.push(row!.id);
  return row!.id;
}

async function addItem(dripId: string, lead: { id: string; mobile: string }, seq: number, name: string | null = 'Ravi Kumar'): Promise<string> {
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_wa_drip_item (drip_id, seq, record_id, label, first_name, handle) VALUES ($1,$2,$3,'Lead',$4,$5) RETURNING id`,
    [dripId, seq, lead.id, name ?? '', lead.mobile.slice(-10)],
  );
  return row!.id;
}

const itemStatus = async (id: string): Promise<{ status: string; skip_reason: string | null }> =>
  (await db.queryOne<{ status: string; skip_reason: string | null }>(`SELECT status, skip_reason FROM ipy_wa_drip_item WHERE id = $1`, [id]))!;
const makeDue = async (id: string): Promise<void> => {
  await db.query(`UPDATE ipy_wa_drip SET next_send_at = now() - interval '1 minute' WHERE id = $1`, [id]);
  // So the number's own spacing rule (a different brake) is not what this test is about.
  await db.query(`UPDATE ipy_message SET created_at = created_at - interval '10 minutes' WHERE provider = $1 AND created_at > now() - interval '9 minutes'`, [OPENWA_PROVIDER]);
};

beforeAll(async () => {
  app = createApp();
  admin = await adminToken(app);
  rep = await signIn(app, SEEDED.executiveA);
  adminId = (await db.queryOne<{ id: string }>(`SELECT id FROM ipy_user WHERE is_admin AND is_active ORDER BY created_at, id LIMIT 1`))!.id;
  fake = await startFakeOpenWa({ sessionName: 'drip-company' });

  const active = await db.query(`SELECT provider FROM ipy_integration WHERE provider LIKE 'whatsapp\\_%' AND is_active`);
  previouslyActive.push(...active.rows.map((r) => String((r as { provider: string }).provider)));
  await db.query(`UPDATE ipy_integration SET is_active = false WHERE provider LIKE 'whatsapp\\_%'`);
  await saveIntegration(OPENWA_PROVIDER, {
    config: { baseUrl: fake.baseUrl, sessionName: 'drip-company' },
    credentials: { apiKey: fake.apiKey, webhookSecret: 'integration-webhook-secret-123456' },
    isActive: true,
  });
  await reloadIntegrations();
  __resetOpenWaCaches();

  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_wa_number (session_name, session_id, label, status) VALUES ('drip-company', $1, 'Drip test number', 'ready')
     ON CONFLICT (session_name) DO UPDATE SET status = 'ready', paused = false, session_id = EXCLUDED.session_id RETURNING id`,
    [fake.sessionId],
  );
  numberId = row!.id;
});

afterEach(async () => {
  // Each test starts with this number's spacing rule (a different brake) long since satisfied.
  await db.query(`UPDATE ipy_message SET created_at = created_at - interval '10 minutes' WHERE provider = $1 AND created_at > now() - interval '9 minutes'`, [OPENWA_PROVIDER]);
  fake.status = 'ready';
  fake.restriction = null;
  fake.failSends = false;
  fake.sends.length = 0;
  __resetOpenWaCaches();
  await db.query(`UPDATE ipy_wa_number SET status = 'ready', paused = false WHERE id = $1`, [numberId]);
  await db.query(`UPDATE ipy_wa_drip SET status = 'stopped' WHERE id = ANY($1)`, [dripIds]);
  await db.query(`DELETE FROM ipy_wa_drip WHERE id = ANY($1)`, [dripIds]);
  dripIds.length = 0;
  await db.query(`DELETE FROM ipy_wa_lookup WHERE record_id = ANY($1)`, [leads.map((l) => l.id)]);
  await db.query(`DELETE FROM ipy_channel_optout WHERE right(regexp_replace(handle, '\\D', '', 'g'), 10) = ANY($1)`, [leads.map((l) => l.mobile.slice(-10))]);
});

afterAll(async () => {
  await fake.close();
  await db.query(`DELETE FROM ipy_record WHERE id = ANY($1)`, [leads.map((l) => l.id)]);
  await db.query(`DELETE FROM ipy_wa_number WHERE id = $1`, [numberId]).catch(() => undefined);
  await db.query(`UPDATE ipy_integration SET is_active = false WHERE provider = $1`, [OPENWA_PROVIDER]);
  for (const provider of previouslyActive) {
    if (provider !== OPENWA_PROVIDER) await db.query(`UPDATE ipy_integration SET is_active = true WHERE provider = $1`, [provider]);
  }
  await reloadIntegrations();
});

describe('one message at a time', () => {
  it('sends one, ends it with the opt-out line, and waits at least a minute before the next', async () => {
    const [a, b] = [await newLead('Drip A'), await newLead('Drip B')];
    const drip = await newDrip();
    const first = await addItem(drip, a, 1);
    const second = await addItem(drip, b, 2);

    expect(await dripTick(NOON)).toBe('sent');
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]!.text).toMatch(/Reply STOP to stop$/);
    expect(fake.sends[0]!.text).toContain('Ravi');
    expect(fake.sends[0]!.chatId).toContain(`91${a.mobile}`);
    expect((await itemStatus(first)).status).toBe('sent');
    expect((await itemStatus(second)).status).toBe('pending');

    const wait = await db.queryOne<{ s: string }>(`SELECT EXTRACT(EPOCH FROM (next_send_at - now())) AS s FROM ipy_wa_drip WHERE id = $1`, [drip]);
    expect(Number(wait!.s)).toBeGreaterThanOrEqual(55);
    // Not due again yet: the clock does nothing.
    expect(await dripTick(NOON)).toBe('idle');
    expect(fake.sends).toHaveLength(1);

    // The admin's own typing allowance is untouched by the queue.
    expect((await currentCounts(adminId, a.mobile.slice(-10), numberId)).userToday).toBe(0);

    // Who/which number/when is on the numbers screen, marked as the queue.
    const log = await request(app).get('/api/whatsapp-numbers/log/sends').set('Authorization', `Bearer ${admin}`);
    expect(log.status).toBe(200);
    expect(log.body.find((r: { queue_name: string | null }) => r.queue_name === 'Test drip')).toMatchObject({ number_label: 'Drip test number' });
  });

  it('sends nothing outside the daytime window', async () => {
    const a = await newLead('Drip Night');
    const drip = await newDrip();
    await addItem(drip, a, 1);
    expect(await dripTick(NIGHT)).toBe('waiting');
    expect(fake.sends).toHaveLength(0);
  });

  it('stops at the number of messages it was told to send', async () => {
    const [a, b] = [await newLead('Drip Cap A'), await newLead('Drip Cap B')];
    const drip = await newDrip();
    await db.query(`UPDATE ipy_wa_drip SET max_total = 1 WHERE id = $1`, [drip]);
    await addItem(drip, a, 1);
    await addItem(drip, b, 2);
    expect(await dripTick(NOON)).toBe('sent');
    expect((await readDrip(drip)).status).toBe('done');
    expect(fake.sends).toHaveLength(1);
  });

  it('holds to the daily cap per number', async () => {
    const [a, b] = [await newLead('Drip Day A'), await newLead('Drip Day B')];
    const drip = await newDrip({ capStart: 1 });
    await addItem(drip, a, 1);
    const second = await addItem(drip, b, 2);
    expect(await dripTick(NOON)).toBe('sent');
    await makeDue(drip);
    expect(await dripTick(NOON)).toBe('waiting');
    expect(fake.sends).toHaveLength(1);
    expect((await itemStatus(second)).status).toBe('pending');
  });
});

describe('who is skipped', () => {
  it('leaves out a number that said STOP, one not on WhatsApp, and a deleted record — and still reaches the next person', async () => {
    const stopped = await newLead('Drip Stop');
    const notOn = await newLead('Drip NotOn');
    const gone = await newLead('Drip Gone');
    const fine = await newLead('Drip Fine');
    fake.onWhatsApp.delete(`91${notOn.mobile}`);
    await recordConsent({ handle: `+91${stopped.mobile}`, channel: 'whatsapp', action: 'opt_out', source: 'keyword', messageText: 'STOP' });
    await db.query(`UPDATE ipy_record SET is_deleted = true WHERE id = $1`, [gone.id]);

    const drip = await newDrip();
    const items = [await addItem(drip, stopped, 1), await addItem(drip, gone, 2), await addItem(drip, notOn, 3), await addItem(drip, fine, 4)];

    expect(await dripTick(NOON)).toBe('waiting'); // the WhatsApp check ends the turn: not two lookups in a row
    await makeDue(drip);
    expect(await dripTick(NOON)).toBe('sent');

    expect(await itemStatus(items[0]!)).toEqual({ status: 'skipped', skip_reason: 'opted_out' });
    expect(await itemStatus(items[1]!)).toEqual({ status: 'skipped', skip_reason: 'record_gone' });
    expect(await itemStatus(items[2]!)).toEqual({ status: 'skipped', skip_reason: 'not_on_whatsapp' });
    expect((await itemStatus(items[3]!)).status).toBe('sent');
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]!.chatId).toContain(`91${fine.mobile}`);
  });

  it('never messages the same number twice, even from another queue', async () => {
    const a = await newLead('Drip Twice');
    const first = await newDrip();
    await addItem(first, a, 1);
    expect(await dripTick(NOON)).toBe('sent');
    await db.query(`UPDATE ipy_wa_drip SET status = 'done' WHERE id = $1`, [first]);

    const second = await newDrip();
    const again = await addItem(second, a, 1);
    const b = await newLead('Drip Once');
    await addItem(second, b, 2);
    await makeDue(second);
    expect(await dripTick(NOON)).toBe('sent');
    expect(await itemStatus(again)).toEqual({ status: 'skipped', skip_reason: 'already_messaged' });
    expect(fake.sends.map((s) => s.chatId).filter((c) => c.includes(a.mobile))).toHaveLength(1);
  });
});

describe('it stops itself, and tells the admins', () => {
  const alerts = async (): Promise<number> =>
    Number((await db.queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM ipy_notification WHERE user_id = $1 AND title LIKE 'WhatsApp queue%paused itself'`, [adminId]))!.n);

  it('when a number drops', async () => {
    const a = await newLead('Drip Down');
    const drip = await newDrip();
    await addItem(drip, a, 1);
    const before = await alerts();
    await db.query(`UPDATE ipy_wa_number SET status = 'disconnected' WHERE id = $1`, [numberId]);
    expect(await dripTick(NOON)).toBe('paused');
    const row = await readDrip(drip);
    expect(row.status).toBe('paused');
    expect(row.paused_by_system).toBe(true);
    expect(row.pause_reason).toContain('Drip test number');
    expect(fake.sends).toHaveLength(0);
    expect(await alerts()).toBe(before + 1);
    // And it does not wake itself up when the number comes back.
    await db.query(`UPDATE ipy_wa_number SET status = 'ready' WHERE id = $1`, [numberId]);
    expect(await dripTick(NOON)).toBe('idle');
  });

  it('when WhatsApp reports a restriction', async () => {
    const a = await newLead('Drip Limited');
    const drip = await newDrip();
    await addItem(drip, a, 1);
    fake.restriction = { kind: 'reachout_timelock', code: 'x' };
    __resetOpenWaCaches();
    expect(await dripTick(NOON)).toBe('paused');
    expect((await readDrip(drip)).pause_reason).toContain('limited');
    expect(fake.sends).toHaveLength(0);
  });

  it('on the third failed send', async () => {
    const people = [await newLead('Drip F1'), await newLead('Drip F2'), await newLead('Drip F3'), await newLead('Drip F4')];
    const drip = await newDrip();
    for (const [i, p] of people.entries()) await addItem(drip, p, i + 1);
    fake.failSends = true;
    expect(await dripTick(NOON)).toBe('waiting');
    await makeDue(drip);
    expect(await dripTick(NOON)).toBe('waiting');
    await makeDue(drip);
    expect(await dripTick(NOON)).toBe('paused');
    expect((await readDrip(drip)).pause_reason).toContain('failed');
    const failed = await db.queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM ipy_wa_drip_item WHERE drip_id = $1 AND status = 'failed'`, [drip]);
    expect(Number(failed!.n)).toBe(3);
  });
});

describe('starting, and who may', () => {
  it('only admins reach it', async () => {
    expect([401, 403]).toContain((await request(app).get('/api/whatsapp-drip').set('Authorization', `Bearer ${rep}`)).status);
    const res = await request(app).get('/api/whatsapp-drip').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.defaults.variants).toHaveLength(DEFAULT_VARIANTS.length);
    expect(res.body.defaults.hardMaxPerNumberPerDay).toBeLessThan(60);
  });

  it('shows who is in a list, then starts only if the count is still the count; only one runs at a time', async () => {
    const views = await request(app).get('/api/views/leads').set('Authorization', `Bearer ${admin}`);
    const view = views.body[0]?.id as string;
    expect(view).toBeTruthy();

    const preview = await request(app).post('/api/whatsapp-drip/preview').set('Authorization', `Bearer ${admin}`).send({ view, variants: DEFAULT_VARIANTS });
    expect(preview.status).toBe(200);
    expect(preview.body.reachable).toBeGreaterThan(0);
    expect(preview.body.sample[0].text).toMatch(/Reply STOP to stop$/);
    expect(preview.body.sample[0].to).toMatch(/\*\*\*\*\*\*/); // masked

    const made = await request(app).post('/api/whatsapp-drip').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Start test', view, variants: DEFAULT_VARIANTS, numberIds: [numberId] });
    expect(made.status).toBe(200);
    dripIds.push(made.body.id);

    const wrong = await request(app).post(`/api/whatsapp-drip/${made.body.id}/start`).set('Authorization', `Bearer ${admin}`)
      .send({ expectedCount: preview.body.reachable + 1 });
    expect(wrong.status).toBe(400);

    const started = await request(app).post(`/api/whatsapp-drip/${made.body.id}/start`).set('Authorization', `Bearer ${admin}`)
      .send({ expectedCount: preview.body.reachable, confirmLarge: true });
    expect(started.status).toBe(200);
    expect(started.body.frozen).toBe(preview.body.reachable);
    expect((await readDrip(made.body.id)).status).toBe('running');

    // A second queue cannot start while one runs.
    const other = await newDrip({ status: 'draft' });
    await expect(startDrip({ ctx: await adminContext(), userId: adminId, dripId: other, expectedCount: 1 })).rejects.toThrow(/already running/);

    const events = await db.query<{ kind: string }>(`SELECT kind FROM ipy_wa_drip_event WHERE drip_id = $1 ORDER BY at`, [made.body.id]);
    expect(events.rows.map((e) => e.kind)).toEqual(['created', 'started']);

    await stopDrip(made.body.id, adminId);
    expect((await readDrip(made.body.id)).status).toBe('stopped');
  });
});
