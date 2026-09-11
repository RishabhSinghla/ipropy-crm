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
import { markContacted } from '../../core/entity/payloadColumns.js';

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

  const row = await db.queryOne<{ record_id: string; module_name: string }>(
    `SELECT r.id AS record_id, r.module_name
     FROM ipy_e_leads l JOIN ipy_record r ON r.id = l.record_id
     WHERE r.is_deleted = false
       -- Every one of these is a field an admin may retire, and
       -- whatsapp_number already went with migration 060. Naming one raises
       -- 42703, and the companion app then matches no caller to any contact.
       AND (right(regexp_replace(COALESCE(to_jsonb(l)->>'mobile',''), '\\D','','g'), 10) = $1
         OR right(regexp_replace(COALESCE(to_jsonb(l)->>'alternate_phone',''), '\\D','','g'), 10) = $1
         OR right(regexp_replace(COALESCE(to_jsonb(l)->>'whatsapp_number',''), '\\D','','g'), 10) = $1)
     ORDER BY CASE to_jsonb(l)->>'status' WHEN 'Converted' THEN 0 WHEN 'Negotiation' THEN 1 ELSE 2 END,
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
            trim(u.first_name || ' ' || u.last_name) AS user_name,
            (SELECT count(*) FROM ipy_call c WHERE c.device_id = d.id)::int AS call_count
     FROM ipy_device d JOIN ipy_user u ON u.id = d.user_id
     WHERE d.user_id = $1 OR $2
     ORDER BY d.created_at DESC`,
    [userId, isAdmin],
  );
  return rows.rows;
}

export async function revokeDevice(deviceId: string, userId: string, isAdmin: boolean): Promise<void> {
  await db.query(
    `UPDATE ipy_device SET is_active = false WHERE id = $1 AND (user_id = $2 OR $3)`,
    [deviceId, userId, isAdmin],
  );
}
