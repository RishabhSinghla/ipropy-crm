/**
 * "Is this contact on WhatsApp, and what do they call themselves?" for every contact, slowly.
 *
 * Each check is a query WhatsApp sees about a third party, and bulk checking is the pattern most likely to get a
 * number restricted. So this job is built to be boring on purpose:
 *  - started by an admin, never by itself;
 *  - one number at a time with a random 8–20 second pause (an even beat looks like a robot);
 *  - a daily cap (default 150, never above 500) counted from the CRM's own rows, so a restart cannot reset it;
 *  - resumable: a contact with a row in `ipy_wa_lookup` is not asked about again (a failed one waits a day);
 *  - it stops by itself when OpenWA is unreachable or the phone is not linked.
 *
 * Privacy: only the name the person chose for themselves (`pushName`, never the company's own address-book name) and
 * their public profile picture are kept. A number that is not on WhatsApp keeps only that fact. Nothing already
 * typed on the record is overwritten.
 */
import { db } from '../../../db/pool.js';
import { logger } from '../../../utils/logger.js';
import { loadUser } from '../../../middleware/auth.js';
import { buildScopeContext } from '../../../core/permissions/index.js';
import { updateRecord } from '../../../core/entity/recordService.js';
import { getDriver } from '../../../core/storage/index.js';
import { buildStorageKey } from '../../../core/storage/keys.js';
import { OpenWaError, openWaCheckNumber, openWaProfilePictureUrl, openWaPushName } from './openwa.js';
import { dialableNumber } from './send.js';

export const DEFAULT_DAILY_CAP = 150;
export const MAX_DAILY_CAP = 500;
export const PAUSE_BETWEEN_CHECKS_MS = { min: 8_000, max: 20_000 };
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

/** Profile pictures live on WhatsApp's own CDN. Anything else is not fetched: the address comes from outside the CRM. */
export function isWhatsAppPhotoHost(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)(whatsapp\.net|fbcdn\.net|whatsapp\.com)$/i.test(u.hostname);
  } catch {
    return false;
  }
}

export function cappedDailyLimit(asked: unknown): number {
  const n = Math.floor(Number(asked));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAILY_CAP;
  return Math.min(Math.max(n, 10), MAX_DAILY_CAP);
}

export interface CheckJob {
  running: boolean;
  cap: number;
  checkedThisRun: number;
  note: string | null;
  stopRequested: boolean;
}
const job: CheckJob = { running: false, cap: DEFAULT_DAILY_CAP, checkedThisRun: 0, note: null, stopRequested: false };

const TODAY = `checked_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`;

/** Contacts that could still be checked: a mobile, not deleted or archived, no answer yet (or a failure over a day old). */
const CANDIDATES = `
  FROM ipy_record r
  JOIN ipy_e_leads l ON l.record_id = r.id
  LEFT JOIN ipy_wa_lookup w ON w.record_id = r.id
 WHERE r.is_deleted = false AND r.archived_at IS NULL
   AND coalesce(l.mobile, '') <> ''
   AND (w.record_id IS NULL OR (w.status = 'failed' AND w.checked_at < now() - interval '1 day'))`;

export async function numberCheckStatus(): Promise<CheckJob & { checkedToday: number; remaining: number; found: number; notOnWhatsApp: number }> {
  const today = await db.queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM ipy_wa_lookup WHERE ${TODAY}`);
  const remaining = await db.queryOne<{ n: number }>(`SELECT count(*)::int AS n ${CANDIDATES}`);
  const totals = await db.queryOne<{ found: number; not_on: number }>(
    `SELECT count(*) FILTER (WHERE status = 'on_whatsapp')::int AS found,
            count(*) FILTER (WHERE status = 'not_on_whatsapp')::int AS not_on FROM ipy_wa_lookup`);
  return { ...job, checkedToday: today?.n ?? 0, remaining: remaining?.n ?? 0, found: totals?.found ?? 0, notOnWhatsApp: totals?.not_on ?? 0 };
}

async function writeContext() {
  const admin = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_user WHERE is_admin AND is_active ORDER BY created_at LIMIT 1`);
  const user = admin ? await loadUser(admin.id) : null;
  if (!user) throw new Error('There is no active admin to record this as.');
  return { ...(await buildScopeContext(user)), system: true, source: 'whatsapp_number_check' };
}

async function saveAvatar(recordId: string, url: string): Promise<'saved' | 'skipped'> {
  if (!isWhatsAppPhotoHost(url)) return 'skipped';
  const has = await db.queryOne<{ one: number }>(`SELECT 1 AS one FROM ipy_attachment WHERE record_id = $1 AND category = 'avatar' LIMIT 1`, [recordId]);
  if (has) return 'skipped'; // a photo somebody chose themselves is never replaced
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
  if (!res.ok || !type.startsWith('image/')) return 'skipped';
  const data = Buffer.from(await res.arrayBuffer());
  if (!data.byteLength || data.byteLength > MAX_PHOTO_BYTES) return 'skipped';
  const ext = type === 'image/png' ? '.png' : '.jpg';
  const name = `whatsapp-profile${ext}`;
  const key = await buildStorageKey({ recordId, originalName: name, ext });
  await (await getDriver()).save(key, data, type);
  await db.query(
    `INSERT INTO ipy_attachment (record_id, file_name, mime_type, size, storage_key, url, category)
     VALUES ($1,$2,$3,$4,$5,$6,'avatar')`,
    [recordId, name, type, data.byteLength, key, `/api/files/${key}`],
  );
  return 'saved';
}

async function remember(recordId: string, status: string, pushName: string | null, photo: string, note: string | null): Promise<void> {
  await db.query(
    `INSERT INTO ipy_wa_lookup (record_id, status, push_name, photo, note, checked_at) VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (record_id) DO UPDATE SET status = EXCLUDED.status, push_name = EXCLUDED.push_name,
       photo = EXCLUDED.photo, note = EXCLUDED.note, checked_at = now()`,
    [recordId, status, pushName, photo, note],
  );
}

/** One contact. Exported for the test; the job calls it in a loop. */
export async function checkOne(row: { id: string; mobile: string }): Promise<void> {
  const number = await dialableNumber(null, row.mobile, row.id);
  if (!number) { await remember(row.id, 'failed', null, 'none', 'No country code, so the number is not certain'); return; }

  const found = await openWaCheckNumber(number);
  if (!found.exists || !found.waId) { await remember(row.id, 'not_on_whatsapp', null, 'none', null); return; }

  const pushName = await openWaPushName(found.waId);
  let photo: 'saved' | 'skipped' | 'none' = 'none';
  try {
    const url = await openWaProfilePictureUrl(found.waId);
    if (url) photo = await saveAvatar(row.id, url);
  } catch (err) {
    // No picture is an ordinary answer; a refused lookup must not lose the name we already have.
    if (err instanceof OpenWaError && err.code === 'UNREACHABLE') throw err;
    logger.debug({ err, recordId: row.id }, 'whatsapp number check: no profile picture');
  }

  if (pushName) {
    const current = await db.queryOne<{ v: string | null }>(`SELECT l.whatsapp_name AS v FROM ipy_e_leads l WHERE l.record_id = $1`, [row.id]);
    if (!current?.v?.trim()) {
      await updateRecord(await writeContext(), 'leads', row.id, { whatsapp_name: pushName }, { skipWorkflow: true });
    }
  }
  await remember(row.id, 'on_whatsapp', pushName, photo, null);
}

export function stopNumberCheck(): void { job.stopRequested = true; }

export function startNumberCheck(asked?: unknown): { started: boolean; reason?: string } {
  if (job.running) return { started: false, reason: 'A number check is already running.' };
  job.running = true;
  job.stopRequested = false;
  job.cap = cappedDailyLimit(asked);
  job.checkedThisRun = 0;
  job.note = null;

  void (async () => {
    try {
      for (;;) {
        if (job.stopRequested) { job.note = 'Stopped.'; break; }
        const today = await db.queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM ipy_wa_lookup WHERE ${TODAY}`);
        if ((today?.n ?? 0) >= job.cap) { job.note = `Today's limit of ${job.cap} is reached. Press start again tomorrow.`; break; }
        const next = await db.queryOne<{ id: string; mobile: string }>(`SELECT r.id, l.mobile ${CANDIDATES} ORDER BY r.updated_at DESC LIMIT 1`);
        if (!next) { job.note = 'Every contact with a mobile has been checked.'; break; }
        try {
          await checkOne(next);
        } catch (err) {
          if (err instanceof OpenWaError && (err.code === 'UNREACHABLE' || err.status === 400 || err.status === 409 || err.status === 401)) {
            job.note = `Stopped: ${err.message}`;
            break;
          }
          await remember(next.id, 'failed', null, 'none', (err as Error).message.slice(0, 200));
        }
        job.checkedThisRun += 1;
        const { min, max } = PAUSE_BETWEEN_CHECKS_MS;
        await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));
      }
    } catch (err) {
      job.note = `Stopped: ${(err as Error).message}`;
      logger.error({ err }, 'whatsapp number check stopped');
    } finally {
      job.running = false;
    }
  })();
  return { started: true };
}
