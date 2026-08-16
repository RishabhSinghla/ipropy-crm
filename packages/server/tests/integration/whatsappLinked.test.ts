/**
 * Handing a message to a linked phone, and what happens afterwards.
 *
 * The unit tests cover the arithmetic. This covers the SQL, which is where the
 * damage would actually be: claiming the same message twice sends a customer
 * the same thing from two numbers, and a claim that never releases means a
 * queue that silently stops.
 *
 * Written against the module rather than the HTTP routes because that is where
 * the ordering, locking and consent live. The routes are three lines of zod on
 * top of these calls.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { db } from '../../src/db/pool.js';
import { createRecord, deleteRecord } from '../../src/core/entity/recordService.js';
import { queueDeviceSend } from '../../src/integrations/whatsapp/deviceSend.js';
import { recordConsent } from '../../src/integrations/whatsapp/consent.js';
import {
  claimOutbox,
  createLink,
  getLink,
  markConnected,
  releaseStaleClaims,
  removeLink,
  reportResult,
} from '../../src/integrations/whatsapp/linkedDevice.js';
import { adminContext, authUser, leadInput } from './fixtures.js';

/** Unique to this run, so a parallel suite's rows can never be mistaken for ours. */
const RUN = String(Date.now()).slice(-8);
const MOBILE = `98${RUN}`;
const HANDLE = `+91${MOBILE}`;

let linkId = '';
let userId = '';
let leadId = '';

/**
 * Pretend the pacing gap has already passed.
 *
 * The gap is real time and deliberately tens of seconds, so a test that waited
 * it out honestly would take minutes. Moving the clock backwards on the link is
 * the same thing without the wall-clock cost.
 */
async function allowAnotherSend(): Promise<void> {
  await db.query(`UPDATE ipy_wa_link SET last_sent_at = now() - interval '1 hour' WHERE id = $1`, [linkId]);
}

/** Undo an opt-out completely: the state table, the log, and the lead's flag. */
async function clearOptOut(): Promise<void> {
  await db.query(`DELETE FROM ipy_channel_optout WHERE handle = $1`, [HANDLE]);
  await db.query(`DELETE FROM ipy_consent_event WHERE handle = $1`, [HANDLE]);
  await db.query(`UPDATE ipy_e_leads SET do_not_whatsapp = false WHERE record_id = $1`, [leadId]);
}

/** Turn the provider on for the duration, since claiming refuses when it is off. */
async function enableLinkedSending(): Promise<void> {
  await db.query(
    `UPDATE ipy_integration SET is_active = true,
       credentials = jsonb_build_object('bridgeToken', $1::text)
     WHERE provider = 'whatsapp_linked'`,
    ['itest-token'],
  );
  const { invalidate, warmup } = await import('../../src/core/settings/integrations.js');
  invalidate();
  await warmup();
}

/**
 * The organisation timezone this suite found, so it can be put back.
 *
 * Not optional housekeeping. The integration suites share one database, and
 * leaving this on UTC broke a capture test three files later that asserts a
 * photo with no EXIF offset is read in the organisation's zone. A setting
 * changed for a test and not restored is somebody else's mystery failure.
 */
let previousTimezone: string | null = null;

beforeAll(async () => {
  // Sending hours are checked against the wall clock, and a suite that only
  // passes between 8am and 9pm is a suite that fails the night before a
  // release. Pinned to UTC for the run and restored in afterAll.
  const existing = await db.queryOne<{ value: string }>(
    `SELECT value #>> '{}' AS value FROM ipy_setting WHERE key = 'org.timezone'`,
  );
  previousTimezone = existing?.value ?? null;
  await db.query(
    `INSERT INTO ipy_setting (key, value, category, label)
     VALUES ('org.timezone', '"UTC"', 'general', 'Timezone')
     ON CONFLICT (key) DO UPDATE SET value = '"UTC"'`,
  );

  await enableLinkedSending();

  const admin = await authUser('admin@ipropy.com');
  userId = admin.id;

  const ctx = await adminContext();
  const lead = await createRecord(ctx, 'leads', leadInput({
    full_name: `Linked Test ${RUN}`,
    mobile: MOBILE,
    country_code: '+91',
  }), { skipWorkflow: true });
  leadId = lead.id;

  const link = await createLink({ userId, label: 'itest', takesUnassigned: true });
  linkId = link.id;
  await markConnected(linkId, HANDLE);
});

afterAll(async () => {
  if (linkId) await removeLink(linkId).catch(() => undefined);
  if (leadId) {
    const ctx = await adminContext();
    await deleteRecord(ctx, 'leads', leadId, { hard: true }).catch(() => undefined);
  }
  await db.query(`DELETE FROM ipy_device_send WHERE handle = $1`, [HANDLE]);
  await db.query(`DELETE FROM ipy_channel_optout WHERE handle = $1`, [HANDLE]);
  await db.query(`DELETE FROM ipy_consent_event WHERE handle = $1`, [HANDLE]);
  await db.query(`UPDATE ipy_integration SET is_active = false WHERE provider = 'whatsapp_linked'`);

  if (previousTimezone) {
    await db.query(
      `UPDATE ipy_setting SET value = to_jsonb($1::text) WHERE key = 'org.timezone'`,
      [previousTimezone],
    );
  }
});

describe('claiming a message for a linked phone', () => {
  it('hands out one message and marks it claimed', async () => {
    await queueDeviceSend({ handle: HANDLE, body: `first ${RUN}`, recordId: leadId, assignedTo: userId });
    await allowAnotherSend();

    const claim = await claimOutbox();
    const mine = claim.messages.filter((m) => m.handle === HANDLE);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.body).toBe(`first ${RUN}`);

    const row = await db.queryOne<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM ipy_device_send WHERE id = $1`, [mine[0]!.sendId],
    );
    expect(row!.status).toBe('claimed');
    expect(row!.attempts).toBe(1);

    await reportResult({ sendId: mine[0]!.sendId, ok: true, providerMessageId: `pm_${RUN}_1` });
  });

  it('will not hand out a second one before the gap has passed', async () => {
    await queueDeviceSend({ handle: HANDLE, body: `second ${RUN}`, recordId: leadId, assignedTo: userId });

    // No allowAnotherSend(): the previous claim stamped last_sent_at just now.
    const claim = await claimOutbox();
    expect(claim.messages.filter((m) => m.handle === HANDLE)).toHaveLength(0);
  });

  it('never hands the same message to two polls', async () => {
    await allowAnotherSend();

    // Both polls race for one waiting message. Without SKIP LOCKED and the
    // status flip in the same statement, both would win and the customer would
    // receive it twice.
    const [a, b] = await Promise.all([claimOutbox(), claimOutbox()]);
    const ids = [...a.messages, ...b.messages]
      .filter((m) => m.handle === HANDLE)
      .map((m) => m.sendId);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeLessThanOrEqual(1);

    for (const id of ids) await reportResult({ sendId: id, ok: true, providerMessageId: `pm_${RUN}_2` });
  });

  it('records a success as actually sent, not handed off', async () => {
    // The wa.me path can only say a person was shown the message. This path
    // watched it leave, and the reporting has to be able to tell them apart.
    const msg = await db.queryOne<{ status: string; provider: string; sent_via: string }>(
      `SELECT status, provider, sent_via FROM ipy_message WHERE provider_message_id = $1`,
      [`pm_${RUN}_1`],
    );
    expect(msg).toBeTruthy();
    expect(msg!.status).toBe('sent');
    expect(msg!.provider).toBe('linked');
    expect(msg!.sent_via).toBe('linked');
  });
});

describe('when a send fails', () => {
  it('puts it back once, then leaves it for a person', async () => {
    const { id } = await queueDeviceSend({
      handle: HANDLE, body: `flaky ${RUN}`, recordId: leadId, assignedTo: userId,
    });

    for (const attempt of [1, 2]) {
      await allowAnotherSend();
      const claim = await claimOutbox();
      const mine = claim.messages.find((m) => m.sendId === id);
      expect(mine, `attempt ${attempt} should have claimed it`).toBeTruthy();
      await reportResult({ sendId: id, ok: false, error: 'not on whatsapp' });
    }

    const row = await db.queryOne<{ status: string; attempts: number; reason: string }>(
      `SELECT status, attempts, reason FROM ipy_device_send WHERE id = $1`, [id],
    );
    expect(row!.status).toBe('failed');
    expect(row!.attempts).toBe(2);
    expect(row!.reason).toContain('not on whatsapp');
  });
});

describe('consent', () => {
  it('refuses a message queued before the customer opted out', async () => {
    // The gap that matters. Consent is checked when a message is queued, but a
    // message can wait in this queue for days, and "they told us to stop
    // yesterday" is exactly the case worth catching.
    const { id } = await queueDeviceSend({
      handle: HANDLE, body: `too late ${RUN}`, recordId: leadId, assignedTo: userId,
    });
    await recordConsent({ handle: HANDLE, action: 'opt_out', source: 'keyword', recordId: leadId });
    await allowAnotherSend();

    const claim = await claimOutbox();
    expect(claim.messages.find((m) => m.sendId === id)).toBeUndefined();

    const row = await db.queryOne<{ status: string; reason: string }>(
      `SELECT status, reason FROM ipy_device_send WHERE id = $1`, [id],
    );
    expect(row!.status).toBe('skipped');
    expect(row!.reason).toMatch(/opted out/i);

    // `ipy_consent_event` is the log; `ipy_channel_optout` is the state the
    // send path actually reads. Clearing only the log leaves the number opted
    // out, which is right for the product and was wrong for this cleanup: every
    // later test in the file then had its message correctly refused.
    await clearOptOut();
  });
});

describe('a bridge that dies mid-send', () => {
  it('releases the claim so the message is not stuck forever', async () => {
    const { id } = await queueDeviceSend({
      handle: HANDLE, body: `abandoned ${RUN}`, recordId: leadId, assignedTo: userId,
    });
    await allowAnotherSend();
    const claim = await claimOutbox();
    expect(claim.messages.find((m) => m.sendId === id)).toBeTruthy();

    // Nothing reports back. Age the claim past the threshold rather than
    // waiting ten minutes for it.
    await db.query(`UPDATE ipy_device_send SET claimed_at = now() - interval '30 minutes' WHERE id = $1`, [id]);
    const released = await releaseStaleClaims();
    expect(released).toBeGreaterThanOrEqual(1);

    const row = await db.queryOne<{ status: string }>(`SELECT status FROM ipy_device_send WHERE id = $1`, [id]);
    expect(row!.status).toBe('pending');
  });
});

describe('the daily ceiling', () => {
  it('stops handing anything out once the cap is reached', async () => {
    await queueDeviceSend({ handle: HANDLE, body: `capped ${RUN}`, recordId: leadId, assignedTo: userId });

    const link = await getLink(linkId);
    await db.query(
      `UPDATE ipy_wa_link SET sent_today = $2, sent_today_on = CURRENT_DATE WHERE id = $1`,
      [linkId, link!.dailyCap],
    );
    await allowAnotherSend();

    const claim = await claimOutbox();
    expect(claim.messages.filter((m) => m.handle === HANDLE)).toHaveLength(0);
    expect(claim.idleReason ?? '').toMatch(/daily limit/i);

    await db.query(`UPDATE ipy_wa_link SET sent_today = 0 WHERE id = $1`, [linkId]);
  });
});
