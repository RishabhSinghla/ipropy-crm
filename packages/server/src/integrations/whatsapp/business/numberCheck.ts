/**
 * "Is this contact on WhatsApp, and what do they call themselves?" for every contact, slowly.
 *
 * Each check is a query WhatsApp sees about a third party, and bulk checking is the pattern most likely to get a
 * number restricted. So this job is built to be boring on purpose:
 *  - started by an admin, never by itself;
 *  - each WhatsApp number asks about one contact at a time with its own random 8–20 second pause (an even beat looks
 *    like a robot). With several numbers linked the work is shared between them, so it goes faster without any one
 *    number going faster: a number that is down, paused or not linked is simply left out, and the others carry on;
 *  - a daily cap per number (default 150, never above 500) counted from the CRM's own rows, so a restart cannot reset it;
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
import { columnsOf, fieldText } from '../../../core/entity/payloadColumns.js';
import { getDriver } from '../../../core/storage/index.js';
import { buildStorageKey } from '../../../core/storage/keys.js';
import { OpenWaError, openWaCheckNumber, openWaProfilePictureUrl, openWaPushName } from './openwa.js';
import { dialableNumber } from './send.js';
import { listNumbers, type WaNumber } from './waNumbers.js';

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

export interface WorkerState {
  numberId: string;
  label: string;
  checkedThisRun: number;
  /** working | done (reached its cap or nothing left) | stopped (the number went down or was refused) */
  state: 'working' | 'done' | 'stopped';
  note: string | null;
}

export interface CheckJob {
  running: boolean;
  cap: number;
  checkedThisRun: number;
  note: string | null;
  stopRequested: boolean;
  workers: WorkerState[];
}
const job: CheckJob = { running: false, cap: DEFAULT_DAILY_CAP, checkedThisRun: 0, note: null, stopRequested: false, workers: [] };

const TODAY = `checked_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`;

/**
 * The numbers allowed to do checks: linked and ready, not paused by an admin, and with a session name. Pure so a test
 * can pin it. A number that is "qr_ready", "disconnected", "failed" … is never asked to do anything.
 */
export function eligibleNumbers(numbers: Pick<WaNumber, 'id' | 'sessionName' | 'status' | 'paused'>[]): typeof numbers {
  return numbers.filter((n) => n.status === 'ready' && !n.paused && n.sessionName.trim() !== '');
}

/** Checks a number already did today. Rows from before numbers were recorded (no number) count against the company number. */
async function doneTodayBy(numberId: string, isDefault: boolean): Promise<number> {
  const r = await db.queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM ipy_wa_lookup WHERE ${TODAY} AND (number_id = $1 OR ($2::boolean AND number_id IS NULL))`,
    [numberId, isDefault]);
  return r?.n ?? 0;
}

/**
 * The contacts that could still be checked, and the digits of the number the CRM uses for WhatsApp for each: the
 * explicit WhatsApp Number, else the mobile. Built per call because an administrator can delete either field, and a
 * query naming a deleted column is a 42703 (`fieldText` answers NULL for a column that is gone).
 *
 * A contact is a candidate when it has a number and either was never checked, was checked under a different number,
 * or failed more than a day ago. Not deleted, not archived.
 */
async function candidates(): Promise<{ digits: string; from: string }> {
  const present = await columnsOf('ipy_e_leads');
  const digits = `regexp_replace(coalesce(nullif(${fieldText(present, 'l', 'whatsapp_number')}, ''), ${fieldText(present, 'l', 'mobile')}, ''), '\\D', '', 'g')`;
  const from = `
  FROM ipy_record r
  JOIN ipy_e_leads l ON l.record_id = r.id
  LEFT JOIN ipy_wa_lookup w ON w.record_id = r.id
 WHERE r.is_deleted = false AND r.archived_at IS NULL
   AND ${digits} <> ''
   AND (w.record_id IS NULL
        OR w.number IS DISTINCT FROM ${digits}
        OR (w.status = 'failed' AND w.checked_at < now() - interval '1 day'))`;
  return { digits, from };
}

export async function numberCheckStatus(): Promise<CheckJob & { numbersReady: number; checkedToday: number; remaining: number; found: number; notOnWhatsApp: number }> {
  const today = await db.queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM ipy_wa_lookup WHERE ${TODAY}`);
  const remaining = await db.queryOne<{ n: number }>(`SELECT count(*)::int AS n ${(await candidates()).from}`);
  const totals = await db.queryOne<{ found: number; not_on: number }>(
    `SELECT count(*) FILTER (WHERE status = 'on_whatsapp')::int AS found,
            count(*) FILTER (WHERE status = 'not_on_whatsapp')::int AS not_on FROM ipy_wa_lookup`);
  const numbersReady = eligibleNumbers(await listNumbers()).length;
  return { ...job, numbersReady, checkedToday: today?.n ?? 0, remaining: remaining?.n ?? 0, found: totals?.found ?? 0, notOnWhatsApp: totals?.not_on ?? 0 };
}

async function writeContext() {
  const admin = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_user WHERE is_admin AND is_active ORDER BY created_at LIMIT 1`);
  const user = admin ? await loadUser(admin.id) : null;
  if (!user) throw new Error('There is no active admin to record this as.');
  return { ...(await buildScopeContext(user)), system: true, source: 'whatsapp_number_check' };
}

/** A profile picture fetched from WhatsApp's own CDN, or null: wrong host, not an image, empty, or too big. */
export async function downloadProfilePhoto(url: string): Promise<{ data: Buffer; type: string } | null> {
  if (!isWhatsAppPhotoHost(url)) return null;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
  if (!res.ok || !type.startsWith('image/')) return null;
  const data = Buffer.from(await res.arrayBuffer());
  if (!data.byteLength || data.byteLength > MAX_PHOTO_BYTES) return null;
  return { data, type };
}

/**
 * Files a picture as the record's avatar (the newest `avatar` attachment is the one shown).
 * `replace: false` — the checker — never replaces a photo somebody already chose, checked again inside the insert
 * because a rep may upload their own while this one downloads. `replace: true` is a person pressing Save.
 */
export async function storeAvatar(recordId: string, photo: { data: Buffer; type: string }, opts: { replace: boolean }): Promise<'saved' | 'skipped'> {
  if (!opts.replace) {
    const has = await db.queryOne<{ one: number }>(`SELECT 1 AS one FROM ipy_attachment WHERE record_id = $1 AND category = 'avatar' LIMIT 1`, [recordId]);
    if (has) return 'skipped';
  }
  const ext = photo.type === 'image/png' ? '.png' : '.jpg';
  const name = `whatsapp-profile${ext}`;
  const key = await buildStorageKey({ recordId, originalName: name, ext });
  await (await getDriver()).save(key, photo.data, photo.type);
  const inserted = await db.query(
    `INSERT INTO ipy_attachment (record_id, file_name, mime_type, size, storage_key, url, category)
     SELECT $1,$2,$3,$4,$5,$6,'avatar'
      WHERE $7::boolean OR NOT EXISTS (SELECT 1 FROM ipy_attachment WHERE record_id = $1 AND category = 'avatar')`,
    [recordId, name, photo.type, photo.data.byteLength, key, `/api/files/${key}`, opts.replace],
  );
  return inserted.rowCount ? 'saved' : 'skipped';
}

async function saveAvatar(recordId: string, url: string): Promise<'saved' | 'skipped'> {
  const photo = await downloadProfilePhoto(url);
  return photo ? storeAvatar(recordId, photo, { replace: false }) : 'skipped';
}

/** Which WhatsApp number asks. Both empty means the company number on the OpenWA card (the single-number days). */
export interface AskVia { sessionName?: string; numberId?: string | null }

async function remember(row: { id: string; mobile: string }, status: string, pushName: string | null, photo: string, note: string | null, via: AskVia = {}): Promise<void> {
  await db.query(
    `INSERT INTO ipy_wa_lookup (record_id, number, status, push_name, photo, note, checked_at, number_id) VALUES ($1,$6,$2,$3,$4,$5, now(), $7)
     ON CONFLICT (record_id) DO UPDATE SET number = EXCLUDED.number, status = EXCLUDED.status, push_name = EXCLUDED.push_name,
       photo = EXCLUDED.photo, note = EXCLUDED.note, checked_at = now(), number_id = EXCLUDED.number_id`,
    [row.id, status, pushName, photo, note, row.mobile, via.numberId ?? null],
  );
}

/** One contact. Exported for the test; the job calls it in a loop. */
export async function checkOne(row: { id: string; mobile: string }, via: AskVia = {}): Promise<void> {
  // An explicit WhatsApp Number carries its own country code (11+ digits); a plain mobile is completed from the record.
  const number = row.mobile.length > 10 ? row.mobile : await dialableNumber(null, row.mobile, row.id);
  if (!number) { await remember(row, 'failed', null, 'none', 'No country code, so the number is not certain', via); return; }

  const found = await openWaCheckNumber(number, via.sessionName);
  if (!found.exists || !found.waId) { await remember(row, 'not_on_whatsapp', null, 'none', null, via); return; }

  const pushName = await openWaPushName(found.waId, via.sessionName);
  let photo: 'saved' | 'skipped' | 'none' = 'none';
  try {
    const url = await openWaProfilePictureUrl(found.waId, via.sessionName);
    if (url) photo = await saveAvatar(row.id, url);
  } catch (err) {
    // No picture is an ordinary answer; a refused lookup must not lose the name we already have.
    if (err instanceof OpenWaError && err.code === 'UNREACHABLE') throw err;
    logger.debug({ err, recordId: row.id }, 'whatsapp number check: no profile picture');
  }

  if (pushName) {
    const present = await columnsOf('ipy_e_leads');
    const current = await db.queryOne<{ v: string | null }>(`SELECT ${fieldText(present, 'l', 'whatsapp_name')} AS v FROM ipy_e_leads l WHERE l.record_id = $1`, [row.id]);
    if (!current?.v?.trim()) {
      await updateRecord(await writeContext(), 'leads', row.id, { whatsapp_name: pushName }, { skipWorkflow: true });
    }
  }
  await remember(row, 'on_whatsapp', pushName, photo, null, via);
}

export function stopNumberCheck(): void { job.stopRequested = true; }

/** Records being asked about right now, so two numbers never take the same contact. One CRM process runs this. */
const inFlight = new Set<string>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const gap = () => PAUSE_BETWEEN_CHECKS_MS.min + Math.random() * (PAUSE_BETWEEN_CHECKS_MS.max - PAUSE_BETWEEN_CHECKS_MS.min);

/** Errors that mean "this number cannot do checks right now": stop that number, not the others. */
function isNumberProblem(err: unknown): err is OpenWaError {
  return err instanceof OpenWaError && (err.code === 'UNREACHABLE' || (err.status !== null && [400, 401, 404, 409].includes(err.status)));
}

/** One number's loop: its own pacing, its own daily cap, its own stop. */
async function runWorker(n: WaNumber, w: WorkerState): Promise<void> {
  const via: AskVia = { sessionName: n.sessionName, numberId: n.id };
  try {
    for (;;) {
      if (job.stopRequested) { w.state = 'stopped'; w.note = 'Stopped.'; return; }
      // Re-read the number every round: it may have dropped, been paused, or been unlinked since the last check.
      const now = (await listNumbers()).find((x) => x.id === n.id);
      if (!now || now.status !== 'ready' || now.paused) { w.state = 'stopped'; w.note = 'This number went offline or was paused, so it was left out.'; return; }
      if ((await doneTodayBy(n.id, n.isDefault)) >= job.cap) { w.state = 'done'; w.note = `Reached today's limit of ${job.cap}.`; return; }
      const pick = await candidates();
      const exclude = [...inFlight];
      const next = await db.queryOne<{ id: string; mobile: string }>(
        `SELECT r.id, ${pick.digits} AS mobile ${pick.from} AND r.id <> ALL($1::uuid[]) ORDER BY r.updated_at DESC LIMIT 1`, [exclude]);
      if (!next) { w.state = 'done'; w.note = 'Nothing left to check.'; return; }
      inFlight.add(next.id);
      try {
        await checkOne(next, via);
      } catch (err) {
        if (isNumberProblem(err)) { w.state = 'stopped'; w.note = `Stopped: ${err.message}`; return; }
        await remember(next, 'failed', null, 'none', (err as Error).message.slice(0, 200), via);
      } finally {
        inFlight.delete(next.id);
      }
      w.checkedThisRun += 1;
      job.checkedThisRun += 1;
      await sleep(gap());
    }
  } catch (err) {
    w.state = 'stopped';
    w.note = `Stopped: ${(err as Error).message}`;
    logger.error({ err, number: n.sessionName }, 'whatsapp number check: a number stopped');
  }
}

export function startNumberCheck(asked?: unknown): { started: boolean; reason?: string } {
  if (job.running) return { started: false, reason: 'A number check is already running.' };
  job.running = true;
  job.stopRequested = false;
  job.cap = cappedDailyLimit(asked);
  job.checkedThisRun = 0;
  job.note = null;
  job.workers = [];

  void (async () => {
    try {
      const numbers = eligibleNumbers(await listNumbers()) as WaNumber[];
      if (!numbers.length) { job.note = 'No WhatsApp number is linked and ready, so there is nothing to check with. Link a phone in Admin → WhatsApp numbers.'; return; }
      job.workers = numbers.map((n) => ({ numberId: n.id, label: n.label || n.sessionName, checkedThisRun: 0, state: 'working' as const, note: null }));
      // Staggered starts, so the numbers do not all fire in the same second.
      await Promise.all(numbers.map(async (n, i) => {
        await sleep(i * (PAUSE_BETWEEN_CHECKS_MS.min / numbers.length));
        await runWorker(n, job.workers[i]!);
      }));
      const stopped = job.workers.filter((w) => w.state === 'stopped').length;
      job.note = job.stopRequested ? 'Stopped.'
        : stopped === job.workers.length ? 'Every number stopped; see each number below.'
        : job.workers.every((w) => w.note?.startsWith('Nothing left')) ? 'Every contact with a mobile has been checked.'
        : `Finished for today (${job.workers.length - stopped} of ${job.workers.length} numbers ran to their limit or the end).`;
    } catch (err) {
      job.note = `Stopped: ${(err as Error).message}`;
      logger.error({ err }, 'whatsapp number check stopped');
    } finally {
      job.running = false;
    }
  })();
  return { started: true };
}
