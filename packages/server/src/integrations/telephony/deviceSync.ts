/**
 * Call logging from the team's own Android phones.
 *
 * Cloud telephony in India needs a KYC'd virtual number, which takes days and
 * bills per minute. Meanwhile every call the team already makes on their own
 * handsets is invisible to the CRM — which is the actual problem, because those
 * are the calls that happen.
 *
 * A companion app reads the system call log and posts batches here. No
 * telephony account, no per-minute cost, and it captures calls placed from the
 * phone's own dialer rather than only the ones someone remembered to start
 * inside the CRM.
 *
 * Two properties do the heavy lifting:
 *
 *  * **Idempotence.** A phone re-syncing the same window — a reinstall, a
 *    manual "sync now", a retried batch on a flaky connection — must not create
 *    a second copy of every call. The unique index on (device_id, external_id)
 *    enforces that in the database rather than trusting the client to remember
 *    what it already sent.
 *  * **Attribution.** A raw call log is a list of phone numbers. Matching each
 *    one to a lead on the last ten digits is what turns it into CRM history.
 */
import { createHash, randomBytes } from 'node:crypto';
import { toE164 } from '@ipropy/shared';
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { BadRequestError, UnauthorizedError } from '../../utils/errors.js';
import { notify } from '../../core/notifications/index.js';
import { bus } from '../../core/events/bus.js';
import { columnsOf, fieldText, markContacted } from '../../core/entity/payloadColumns.js';

/**
 * Android's CallLog.Calls type constants. Mapped here rather than in the app so
 * a fix ships with the server — the phone app is the thing that is hardest to
 * update, so it should carry as little logic as possible.
 */
const ANDROID_CALL_TYPES: Record<number, string> = {
  1: 'inbound',
  2: 'outbound',
  3: 'missed',
  4: 'inbound',   // voicemail — inbound as far as the CRM cares
  5: 'rejected',
  6: 'blocked',
  7: 'outbound',  // answered externally, e.g. on a paired device
};

export interface DevicePairing {
  deviceId: string;
  token: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Pair a phone. The token is returned exactly once, here, and only its hash is
 * kept — it is a bearer credential for an unattended background sync, so it is
 * treated like a password rather than like an id.
 */
export async function pairDevice(input: {
  userId: string;
  label?: string;
  phoneNumber?: string | null;
  model?: string | null;
}): Promise<DevicePairing> {
  const token = randomBytes(32).toString('base64url');

  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_device (user_id, label, token_hash, token_preview, phone_number, model)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [
      input.userId,
      input.label ?? 'Android phone',
      hashToken(token),
      token.slice(-6),
      input.phoneNumber ? toE164(input.phoneNumber) ?? input.phoneNumber : null,
      input.model ?? null,
    ],
  );

  logger.info({ userId: input.userId, deviceId: row!.id }, 'device paired for call sync');
  return { deviceId: row!.id, token };
}

export interface AuthedDevice {
  id: string;
  userId: string;
  phoneNumber: string | null;
}

export async function authenticateDevice(token: string | undefined): Promise<AuthedDevice> {
  if (!token) throw new UnauthorizedError('Device token required');

  const row = await db.queryOne<{ id: string; user_id: string; phone_number: string | null }>(
    `SELECT id, user_id, phone_number FROM ipy_device
     WHERE token_hash = $1 AND is_active = true`,
    [hashToken(token)],
  );
  if (!row) throw new UnauthorizedError('This device is not paired, or its access was revoked');

  /*
    Heard from. Every device-token request stamps this, which is the only way
    the CRM can tell a quiet phone from an absent one: the background worker
    returns without contacting the server at all when there are no new calls,
    so `last_sync_at` stands still on a handset that is working perfectly.

    Deliberately not awaited — a status column is never worth delaying a call
    upload for, and a failed stamp costs a slightly stale "last seen" rather
    than a lost call.
  */
  void db.query(`UPDATE ipy_device SET last_seen_at = now() WHERE id = $1`, [row.id])
    .catch(() => undefined);

  return { id: row.id, userId: row.user_id, phoneNumber: row.phone_number };
}

export interface DeviceCallEntry {
  /** The handset's own call-log row id. The dedupe key. */
  externalId: string;
  number: string;
  /** Android CallLog type constant. */
  type: number;
  /** Unix milliseconds when the call started. */
  timestamp: number;
  durationSeconds: number;
  contactName?: string | null;
}

export interface SyncResult {
  received: number;
  created: number;
  duplicates: number;
  matched: number;
  skipped: number;
}

/**
 * Ingest a batch of call-log rows.
 *
 * Ordered oldest-first so that when several calls to the same lead arrive in
 * one batch, `last_contacted_at` ends up holding the most recent one rather
 * than whichever happened to be processed last.
 */
export async function syncCalls(device: AuthedDevice, entries: DeviceCallEntry[]): Promise<SyncResult> {
  const result: SyncResult = { received: entries.length, created: 0, duplicates: 0, matched: 0, skipped: 0 };
  if (!entries.length) return result;

  const ordered = [...entries].sort((a, b) => a.timestamp - b.timestamp);

  for (const entry of ordered) {
    const number = toE164(entry.number) ?? entry.number?.trim();
    if (!number || number.length < 4) {
      // Private/unknown numbers arrive as "" or "-1"; there is nothing to file.
      result.skipped++;
      continue;
    }

    const direction = ANDROID_CALL_TYPES[entry.type] ?? 'unknown';
    const started = new Date(entry.timestamp);
    const ended = new Date(entry.timestamp + Math.max(0, entry.durationSeconds) * 1000);

    // A missed or rejected call has no duration and was never connected —
    // recording it as 'completed' would inflate every connect-rate report.
    const connected = direction === 'inbound' || direction === 'outbound';
    const status = connected && entry.durationSeconds > 0 ? 'completed' : 'no_answer';

    const match = await matchLead(number);

    try {
      const alreadySynced = await db.queryOne<{ id: string }>(
        `SELECT id FROM ipy_call WHERE device_id = $1 AND external_id = $2`,
        [device.id, entry.externalId],
      );
      if (alreadySynced) {
        result.duplicates++;
        continue;
      }

      // The disposition popup can be saved before Android uploads its call
      // log. In that order a manual row already represents this same call.
      // Upgrade it with the phone's exact facts instead of inserting a second
      // card in the Calls tab.
      const numberTail = number.replace(/\D/g, '').slice(-10);
      const manual = numberTail.length === 10 ? await db.queryOne<{ id: string }>(
        `SELECT id
           FROM ipy_call
          WHERE user_id = $1 AND direction = $2 AND source = 'manual'
            AND right(regexp_replace(
              CASE WHEN direction = 'outbound' THEN to_number ELSE from_number END,
              '\\D', '', 'g'
            ), 10) = $3
            AND abs(extract(epoch FROM (COALESCE(ended_at, started_at) - $4::timestamptz))) <= 120
            AND abs(duration_seconds - $5::int) <= 120
          ORDER BY abs(extract(epoch FROM (COALESCE(ended_at, started_at) - $4::timestamptz)))
          LIMIT 1`,
        [device.userId, direction, numberTail, ended, Math.max(0, entry.durationSeconds)],
      ) : null;
      if (manual) {
        await db.query(
          `UPDATE ipy_call
              SET from_number = $2, to_number = $3,
                  record_id = COALESCE(record_id, $4),
                  record_module = COALESCE(record_module, $5),
                  status = $6, duration_seconds = $7,
                  provider = 'device', source = 'device', device_id = $8, external_id = $9,
                  started_at = $10, answered_at = $11, ended_at = $12
            WHERE id = $1`,
          [
            manual.id,
            direction === 'outbound' ? (device.phoneNumber ?? 'device') : number,
            direction === 'outbound' ? number : (device.phoneNumber ?? 'device'),
            match?.recordId ?? null, match?.module ?? null,
            status, Math.max(0, entry.durationSeconds), device.id, entry.externalId,
            started, status === 'completed' ? started : null, ended,
          ],
        );
        result.duplicates++;
        if (match) result.matched++;
        continue;
      }

      const inserted = await db.queryOne<{ id: string }>(
        `INSERT INTO ipy_call
          (direction, from_number, to_number, user_id, record_id, record_module,
           status, duration_seconds, provider, source, device_id, external_id,
           started_at, answered_at, ended_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'device','device',$9,$10,$11,$12,$13)
         ON CONFLICT (device_id, external_id) WHERE device_id IS NOT NULL AND external_id IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [
          direction,
          direction === 'outbound' ? (device.phoneNumber ?? 'device') : number,
          direction === 'outbound' ? number : (device.phoneNumber ?? 'device'),
          device.userId,
          match?.recordId ?? null,
          match?.module ?? null,
          status,
          Math.max(0, entry.durationSeconds),
          device.id,
          entry.externalId,
          started,
          status === 'completed' ? started : null,
          ended,
        ],
      );

      if (!inserted) {
        result.duplicates++;
        continue;
      }
      result.created++;
      if (match) result.matched++;

      if (match?.recordId) {
        await db.query(
          `UPDATE ipy_record
           SET last_activity_at = GREATEST(COALESCE(last_activity_at, $2), $2)
           WHERE id = $1`,
          [match.recordId, started],
        );
        if (status === 'completed') {
          await markContacted(match.recordId, { at: started, attempt: true });
          await db.query(
            `UPDATE ipy_sla_tracker SET first_response_at = COALESCE(first_response_at, $2)
             WHERE record_id = $1 AND first_response_at IS NULL`,
            [match.recordId, started],
          );
        } else {
          await markContacted(match.recordId, { attempt: true, reached: false });
        }

        if (Date.now() - started.getTime() <= 10 * 60_000) {
          bus.emitAsync('call.ended', {
            callId: inserted.id, direction, status,
            recordId: match.recordId, userId: device.userId,
          });
        }
      }

      // An inbound call from a number nobody holds is a lead nobody has. That
      // is the single most valuable thing this sync surfaces, so it gets a
      // notification rather than a row someone might notice later.
      if (!match && direction === 'inbound' && entry.durationSeconds > 0
          && Date.now() - started.getTime() <= 10 * 60_000) {
        await notify({
          userId: device.userId,
          kind: 'call',
          title: 'Call from an unknown number',
          body: `${entry.contactName ? `${entry.contactName} · ` : ''}${number} — not in the CRM yet.`,
          link: '/leads',
        }).catch(() => undefined);
      }
    } catch (err) {
      logger.warn({ err, externalId: entry.externalId }, 'device call sync: row failed');
      result.skipped++;
    }
  }

  await db.query(
    `UPDATE ipy_device SET last_sync_at = now(), last_sync_count = $2 WHERE id = $1`,
    [device.id, result.created],
  );

  logger.info({ deviceId: device.id, ...result }, 'device call sync');
  return result;
}

async function matchLead(number: string): Promise<{ recordId: string; module: string } | null> {
  const tail = number.replace(/\D/g, '').slice(-10);
  if (tail.length < 10) return null;

  /*
    Once per uploaded call, and a phone hands over its whole log each sync.

    Every one of these is a field an admin may retire — `whatsapp_number`
    already went with migration 060 — so none is named outright: that raises
    42703 and the companion then matches no caller to any contact at all.

    But `to_jsonb(l)->>'mobile'` builds a JSON object out of every column of
    every contact in the business, and this did it four times per row. Measured
    on 60,000 contacts: 1,556 ms for one lookup, so a phone syncing fifty calls
    would have spent over a minute and timed out. Reading the columns one at a
    time keeps the same protection and the same answer. A field that has gone
    resolves to `NULL::text` and simply never matches, which is what it should
    do.
  */
  const present = await columnsOf('ipy_e_leads');
  const tenDigits = (column: string): string =>
    `right(regexp_replace(COALESCE(${fieldText(present, 'l', column)}, ''), '\\D', '', 'g'), 10)`;

  const row = await db.queryOne<{ record_id: string; module_name: string }>(
    `SELECT r.id AS record_id, r.module_name
     FROM ipy_e_leads l JOIN ipy_record r ON r.id = l.record_id
     WHERE r.is_deleted = false
       AND (${tenDigits('mobile')} = $1
         OR ${tenDigits('alternate_phone')} = $1
         OR ${tenDigits('whatsapp_number')} = $1)
     ORDER BY CASE ${fieldText(present, 'l', 'status')}
                WHEN 'Converted' THEN 0 WHEN 'Negotiation' THEN 1 ELSE 2 END,
              r.updated_at DESC
     LIMIT 1`,
    [tail],
  );
  return row ? { recordId: row.record_id, module: row.module_name } : null;
}

/**
 * Attach a recording the app lifted from the handset's own recorder folder.
 *
 * Android 10 closed the third-party call-recording API, but most Indian OEM
 * builds (Xiaomi, Realme, Samsung, OnePlus) still write their own recordings to
 * a directory an app with storage permission can read. The app matches a file
 * to a call by number and timestamp; this stores it.
 */
export async function attachRecording(input: {
  device: AuthedDevice;
  externalId: string;
  audio: Buffer;
  mimeType: string;
  fileName: string;
}): Promise<{ callId: string | null }> {
  const call = await db.queryOne<{ id: string; record_id: string | null }>(
    `SELECT id, record_id FROM ipy_call WHERE device_id = $1 AND external_id = $2`,
    [input.device.id, input.externalId],
  );
  if (!call) return { callId: null };

  if (input.audio.length > 60 * 1024 * 1024) {
    throw new BadRequestError('That recording is too large to upload');
  }
  if (!input.mimeType.startsWith('audio/')) {
    throw new BadRequestError('The recording must be an audio file');
  }

  const { getDriver } = await import('../../core/storage/index.js');
  const driver = await getDriver();
  const key = `recordings/${call.id}.${extensionFor(input.mimeType, input.fileName)}`;
  await driver.save(key, input.audio, input.mimeType);

  await db.query(
    `UPDATE ipy_call SET recording_key = $2, recording_url = $3 WHERE id = $1`,
    [call.id, key, `/api/telephony/calls/${call.id}/recording`],
  );

  // Transcription and analysis are best-effort and run on whatever AI provider
  // is configured; a missing key leaves the recording perfectly playable.
  void import('../../ai/callAnalysis.js')
    .then((m) => m.analyseCallRecording(call.id))
    .catch((err) => logger.debug({ err, callId: call.id }, 'call analysis skipped'));

  return { callId: call.id };
}

function extensionFor(mimeType: string, fileName: string): string {
  const fromName = fileName.split('.').pop()?.toLowerCase();
  if (fromName && ['mp3', 'm4a', 'mp4', 'amr', 'wav', 'ogg', 'aac', '3gp'].includes(fromName)) return fromName;
  if (mimeType.includes('mpeg')) return 'mp3';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a';
  if (mimeType.includes('amr')) return 'amr';
  if (mimeType.includes('wav')) return 'wav';
  return 'audio';
}

export async function listDevices(userId: string, isAdmin: boolean): Promise<Record<string, unknown>[]> {
  const rows = await db.query(
    `SELECT d.id, d.label, d.platform, d.token_preview, d.phone_number, d.model,
            d.app_version, d.is_active, d.last_sync_at, d.last_sync_count, d.created_at,
            d.last_seen_at, d.app_open_at, d.can_end_call,
            d.live_call_number, d.live_call_state, d.live_call_started_at,
            trim(u.first_name || ' ' || u.last_name) AS user_name,
            (SELECT count(*) FROM ipy_call c WHERE c.device_id = d.id)::int AS call_count,
            /*
              How the last call instruction ended, which is the question
              anybody looking at this list is really asking: "why did pressing
              Call do nothing?". "expired" means the phone never collected it.
            */
            (SELECT c.status FROM ipy_device_command c
              WHERE c.device_id = d.id AND c.kind = 'dial'
              ORDER BY c.created_at DESC LIMIT 1) AS last_dial_status,
            (SELECT c.created_at FROM ipy_device_command c
              WHERE c.device_id = d.id AND c.kind = 'dial'
              ORDER BY c.created_at DESC LIMIT 1) AS last_dial_at
     FROM ipy_device d JOIN ipy_user u ON u.id = d.user_id
     WHERE d.user_id = $1 OR $2
     ORDER BY d.app_open_at DESC NULLS LAST, d.last_seen_at DESC NULLS LAST, d.created_at DESC`,
    [userId, isAdmin],
  );
  return rows.rows;
}

/**
 * The app on this person's phone is open right now.
 *
 * Sent by the app's own screens, which update themselves from the server — so
 * every handset already installed starts reporting this without anybody
 * installing anything, which is the whole reason it is here rather than in the
 * native half.
 *
 * It stamps **the phone a desk Call would ring** — the same "most recently
 * synced active device" `queueDial` picks — because that is the exact promise
 * the status is used to make. Picking by recency is safe here and nowhere
 * else: every device considered belongs to this same person.
 */
export async function markAppOpen(
  userId: string, canEndCall?: boolean, canControlCall?: boolean,
): Promise<{ deviceId: string | null }> {
  const row = await db.queryOne<{ id: string }>(
    `UPDATE ipy_device
        SET app_open_at = now(),
            last_seen_at = now(),
            can_end_call = COALESCE($2, can_end_call),
            can_control_call = COALESCE($3, can_control_call)
      WHERE id = (SELECT id FROM ipy_device WHERE user_id = $1 AND is_active = true
                   ORDER BY last_sync_at DESC NULLS LAST, created_at DESC LIMIT 1)
      RETURNING id`,
    [userId, canEndCall ?? null, canControlCall ?? null],
  );
  return { deviceId: row?.id ?? null };
}

export async function revokeDevice(deviceId: string, userId: string, isAdmin: boolean): Promise<void> {
  await db.query(
    `UPDATE ipy_device SET is_active = false WHERE id = $1 AND (user_id = $2 OR $3)`,
    [deviceId, userId, isAdmin],
  );
}

// ---------------------------------------------------------------------------
// Telling a rep's own phone to place a call
// ---------------------------------------------------------------------------

/**
 * How long a dial instruction is worth acting on.
 *
 * Short on purpose. A phone that was asleep, out of signal or had the app
 * swapped out must never come back and ring a customer for a button somebody
 * pressed hours ago — from the customer's side that is a silent call out of
 * nowhere, and from the rep's side a call they are not holding the phone for.
 * If it is late, it is wrong, and the CRM says so rather than ringing.
 */
const DIAL_TTL_SECONDS = 90;
/*
  A hang-up is worth seconds, not minutes.

  A dial that arrives late rings somebody who was going to be rung anyway. A
  hang-up that arrives late cuts off a *different* conversation — the one the
  rep started afterwards — and there is no undoing that. Twenty seconds is
  longer than the round trip and shorter than any next call.
*/
const HANGUP_TTL_SECONDS = 20;

export interface QueuedDial {
  commandId: string;
  deviceId: string;
  deviceLabel: string;
  expiresAt: string;
}

/**
 * Put "ring this number" in front of the signed-in user's own phone.
 *
 * Which phone, when there is more than one: the most recently synced active
 * one. That choice is safe *here* and would not be elsewhere — every device
 * considered belongs to this same user, so the worst case is the call leaving
 * from their spare handset rather than from somebody else's. (The WhatsApp
 * rebuild carries the same shape as a warning, because there the accounts
 * belonged to different people and "most recent" sent Sheetal's message from
 * Rahul's phone.)
 *
 * Answers null when the user has no paired phone, which is the caller's cue to
 * fall back to the laptop's own dialler rather than to fail.
 */
export async function queueDial(input: {
  userId: string;
  number: string;
  module?: string | null;
  recordId?: string | null;
}): Promise<QueuedDial | null> {
  const digits = input.number.replace(/[^\d+]/g, '');
  if (!digits) throw new BadRequestError('No number to call.');

  const device = await db.queryOne<{ id: string; label: string }>(
    `SELECT id, label FROM ipy_device
      WHERE user_id = $1 AND is_active = true
      ORDER BY last_sync_at DESC NULLS LAST, created_at DESC
      LIMIT 1`,
    [input.userId],
  );
  if (!device) return null;

  /*
    Close out anything this phone never acted on, in the same breath as adding
    the next one. There is no separate sweeper to forget to run, and a row
    sitting on `queued` for ever would read as a call still about to happen.
  */
  await db.query(
    `UPDATE ipy_device_command SET status = 'expired', finished_at = now()
      WHERE device_id = $1 AND status IN ('queued', 'delivered') AND expires_at <= now()`,
    [device.id],
  );

  const row = await db.queryOne<{ id: string; expires_at: string }>(
    `INSERT INTO ipy_device_command (device_id, user_id, kind, payload, module, record_id, expires_at)
     VALUES ($1, $2, 'dial', $3::jsonb, $4, $5, now() + ($6 || ' seconds')::interval)
     RETURNING id, expires_at`,
    [
      device.id,
      input.userId,
      JSON.stringify({ number: digits }),
      input.module ?? null,
      input.recordId ?? null,
      String(DIAL_TTL_SECONDS),
    ],
  );

  return {
    commandId: row!.id,
    deviceId: device.id,
    deviceLabel: device.label,
    expiresAt: row!.expires_at,
  };
}

/** The phone saying what happened, so the CRM never has to guess. */
export async function finishCommand(
  device: AuthedDevice,
  commandId: string,
  outcome: { ok: boolean; error?: string | null },
): Promise<void> {
  /*
    `via: 'app'`, because this route is the native plugin's and nothing else
    holds a device token. The plugin path is the one where the phone rings on
    its own; the dialler fallback runs in the webview and closes the command
    through the session route, which records 'dialler'.

    Without this the good path recorded no `via` at all, so the desk could not
    tell "it is ringing" from "the number is typed in, press the green button"
    — and said the former either way.
  */
  await db.query(
    `UPDATE ipy_device_command
        SET status = $3, finished_at = now(), error = $4,
            payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('via', 'app')
      WHERE id = $1 AND device_id = $2`,
    [commandId, device.id, outcome.ok ? 'done' : 'failed', outcome.error ?? null],
  );
}

/**
 * Ask the rep's own phone to end the call it is on.
 *
 * Only a handset that has reported `can_end_call` is asked — Android grants
 * that to the **default phone app** alone, which the rep has to agree to. A
 * command queued for a phone that cannot act on it would sit there until it
 * expired while the desk waited for a hang-up that was never possible, so the
 * refusal happens here, with a reason the screen can print.
 */
export async function queueHangUp(input: {
  userId: string;
  module?: string | null;
  recordId?: string | null;
}): Promise<QueuedDial | null> {
  const device = await db.queryOne<{ id: string; label: string }>(
    `SELECT id, label FROM ipy_device
      WHERE user_id = $1 AND is_active = true AND can_end_call = true
      ORDER BY app_open_at DESC NULLS LAST, last_seen_at DESC NULLS LAST, created_at DESC
      LIMIT 1`,
    [input.userId],
  );
  if (!device) return null;

  await db.query(
    `UPDATE ipy_device_command SET status = 'expired', finished_at = now()
      WHERE device_id = $1 AND status IN ('queued', 'delivered') AND expires_at <= now()`,
    [device.id],
  );

  const row = await db.queryOne<{ id: string; expires_at: string }>(
    `INSERT INTO ipy_device_command (device_id, user_id, kind, payload, module, record_id, expires_at)
     VALUES ($1, $2, 'hangup', '{}'::jsonb, $3, $4, now() + ($5 || ' seconds')::interval)
     RETURNING id, expires_at`,
    [device.id, input.userId, input.module ?? null, input.recordId ?? null, String(HANGUP_TTL_SECONDS)],
  );

  return {
    commandId: row!.id,
    deviceId: device.id,
    deviceLabel: device.label,
    expiresAt: row!.expires_at,
  };
}

/**
 * What the phone says it can do, and what it is doing right now.
 *
 * Reported by the app rather than assumed from a version number: a build can
 * carry the code and still not be the phone's chosen dialler, and the rep can
 * change that in Android's settings at any moment without telling anybody.
 */
export async function reportPhoneState(device: AuthedDevice, state: {
  canEndCall?: boolean;
  canControlCall?: boolean;
  liveNumber?: string | null;
  liveState?: string | null;
  direction?: 'incoming' | 'outgoing' | null;
  speaker?: boolean;
  muted?: boolean;
}): Promise<LiveCallState> {
  /*
    The clock starts at the first report of `active` for a call and nowhere
    else: a phone reporting "dialling" is ringing somebody who has not picked
    up, and counting from there is the timer the owner asked to stop. A new
    call (dialling or ringing after nothing, or after an ended one) clears the
    last call's clock, so it cannot carry over.
  */
  await db.query(
    `UPDATE ipy_device
        SET can_end_call = COALESCE($2, can_end_call),
            can_control_call = COALESCE($3, can_control_call),
            live_call_connected_at = CASE
              WHEN $5::text IN ('dialling', 'ringing')
                   AND (live_call_state IS NULL OR live_call_state = 'ended') THEN NULL
              WHEN $5::text = 'active' AND live_call_connected_at IS NULL THEN now()
              WHEN $5::text = 'active' AND live_call_state = 'ended' THEN now()
              ELSE live_call_connected_at
            END,
            live_call_ended_at = CASE
              WHEN $5::text = 'ended' AND live_call_state IS DISTINCT FROM 'ended' THEN now()
              WHEN $5::text IN ('dialling', 'ringing', 'active', 'held') THEN NULL
              ELSE live_call_ended_at
            END,
            live_call_number = COALESCE($4, live_call_number),
            live_call_started_at = CASE
              WHEN $5::text IS NULL THEN live_call_started_at
              WHEN live_call_state IS DISTINCT FROM $5::text THEN now()
              ELSE live_call_started_at
            END,
            live_call_state = COALESCE($5, live_call_state),
            live_call_direction = COALESCE($6, live_call_direction),
            live_call_speaker = COALESCE($7, live_call_speaker),
            live_call_muted = COALESCE($8, live_call_muted),
            live_call_updated_at = CASE WHEN $5::text IS NULL THEN live_call_updated_at ELSE now() END,
            last_seen_at = now()
      WHERE id = $1`,
    [
      device.id, state.canEndCall ?? null, state.canControlCall ?? null, state.liveNumber ?? null,
      state.liveState ?? null, state.direction ?? null,
      state.speaker ?? null, state.muted ?? null,
    ],
  );
  const live = await liveCallFor(device.userId);
  // Straight to every open screen of that person — the deck on the desk
  // lights speaker the moment the rep taps it on the handset.
  bus.emit('phone.call', { userId: device.userId, live });
  return live;
}

export interface LiveCallState {
  state: 'dialling' | 'ringing' | 'active' | 'held' | 'ended' | null;
  number: string | null;
  direction: string | null;
  speaker: boolean;
  muted: boolean;
  /** Seconds since they picked up; null before that. Relative, so two clocks never disagree. */
  connectedSecondsAgo: number | null;
  /** How long the call ran, once it has ended. */
  talkedSeconds: number | null;
  /** Seconds since the phone last said anything about this call. */
  updatedSecondsAgo: number | null;
  canControlCall: boolean;
  canEndCall: boolean;
}

/**
 * The call this person's phone is on, as the phone last reported it.
 *
 * The handset most recently heard from wins; a rep with two paired phones is
 * holding the one that spoke last.
 */
export async function liveCallFor(userId: string): Promise<LiveCallState> {
  const row = await db.queryOne<{
    state: string | null; number: string | null; direction: string | null;
    speaker: boolean; muted: boolean; connected_ago: number | null; talked: number | null;
    updated_ago: number | null; can_control_call: boolean; can_end_call: boolean;
  }>(
    `SELECT live_call_state AS state, live_call_number AS number, live_call_direction AS direction,
            live_call_speaker AS speaker, live_call_muted AS muted,
            EXTRACT(EPOCH FROM (now() - live_call_connected_at))::int AS connected_ago,
            EXTRACT(EPOCH FROM (live_call_ended_at - live_call_connected_at))::int AS talked,
            EXTRACT(EPOCH FROM (now() - live_call_updated_at))::int AS updated_ago,
            can_control_call, can_end_call
       FROM ipy_device
      WHERE user_id = $1 AND is_active = true
      ORDER BY live_call_updated_at DESC NULLS LAST, app_open_at DESC NULLS LAST
      LIMIT 1`,
    [userId],
  );
  return {
    state: (row?.state ?? null) as LiveCallState['state'],
    number: row?.number ?? null,
    direction: row?.direction ?? null,
    speaker: Boolean(row?.speaker),
    muted: Boolean(row?.muted),
    connectedSecondsAgo: row?.state === 'ended' ? null : (row?.connected_ago ?? null),
    talkedSeconds: row?.state === 'ended' ? (row?.talked ?? 0) : null,
    updatedSecondsAgo: row?.updated_ago ?? null,
    canControlCall: Boolean(row?.can_control_call),
    canEndCall: Boolean(row?.can_end_call),
  };
}

/** The live-call controls a desk may ask the phone for. `end` travels as a hang-up. */
export type CallControlAction = 'speaker' | 'mute' | 'hold';

/**
 * Ask the rep's phone to switch speaker, mute or hold on the call it is on.
 *
 * Only a handset that is its own calling app is sent anything — Android lets
 * no other app touch a running call — so this answers null rather than
 * queueing an instruction nothing will ever carry out. Twenty seconds to live,
 * like a hang-up: a late "speaker on" landing on the next call is a surprise
 * nobody asked for.
 */
export async function queueCallControl(input: {
  userId: string; action: CallControlAction; on: boolean;
}): Promise<QueuedDial | null> {
  const device = await db.queryOne<{ id: string; label: string }>(
    `SELECT id, label FROM ipy_device
      WHERE user_id = $1 AND is_active = true AND can_control_call = true
      ORDER BY live_call_updated_at DESC NULLS LAST, app_open_at DESC NULLS LAST
      LIMIT 1`,
    [input.userId],
  );
  if (!device) return null;
  const row = await db.queryOne<{ id: string; expires_at: string }>(
    `INSERT INTO ipy_device_command (device_id, user_id, kind, payload, expires_at)
     VALUES ($1, $2, 'control', jsonb_build_object('action', $3::text, 'on', $4::boolean),
             now() + ($5 || ' seconds')::interval)
     RETURNING id, expires_at`,
    [device.id, input.userId, input.action, input.on, String(HANGUP_TTL_SECONDS)],
  );
  return { commandId: row!.id, deviceId: device.id, deviceLabel: device.label, expiresAt: row!.expires_at };
}

/**
 * The next instruction for one handset, claimed as it is handed over.
 *
 * The phone's own call service asks this every second while a call is up,
 * with its device token — so speaker, mute, hold and hang-up reach it even
 * when the app's screen is closed and its web view asleep. The same
 * `FOR UPDATE SKIP LOCKED` claim as the web view's poll, so the two can never
 * both be given one command.
 */
export async function nextCommandFor(device: AuthedDevice): Promise<{
  id: string; kind: string; payload: Record<string, unknown>;
} | null> {
  return db.queryOne(
    `WITH next_command AS (
       SELECT id FROM ipy_device_command
        WHERE device_id = $1 AND status = 'queued' AND expires_at > now()
          -- Live-call commands only. Placing a call is the app's own job and
          -- stays on its road; claiming one here would strand it.
          AND kind IN ('control', 'hangup')
        ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     UPDATE ipy_device_command command SET status = 'delivered', delivered_at = now()
       FROM next_command WHERE command.id = next_command.id
     RETURNING command.id, command.kind, command.payload`,
    [device.id],
  );
}
