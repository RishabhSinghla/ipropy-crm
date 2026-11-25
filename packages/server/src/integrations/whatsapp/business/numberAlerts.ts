/**
 * Tell the admins when a WhatsApp number (an OpenWA session) drops, and when it comes back.
 *
 * Runs on the existing one-minute OpenWA check. Nothing here talks to a new service: the alert is a CRM
 * notification (the bell, plus the browser push `notify()` already sends) and an email through the CRM's own
 * email setting if one is connected. The admin "WhatsApp numbers" screen reads the same status and "since".
 *
 * One outage is one alert: `alerted_at` remembers it, a short grace period ignores blips, and a reminder only
 * follows after a day. Recovery sends one "back" notice and clears the mark.
 */
import { db } from '../../../db/pool.js';
import { logger } from '../../../utils/logger.js';
import { notify } from '../../../core/notifications/index.js';
import { sendEmail } from '../../email/service.js';
import { describeSessionStatus, OpenWaError } from './openwa.js';
import { syncFromOpenWa } from './waNumbers.js';

export const GRACE_MS = 2 * 60_000;
export const REMINDER_MS = 24 * 60 * 60_000;
const SERVICE_KEY = 'whatsapp.openwa_service';

export interface WatchedNumber {
  id: string;
  name: string;
  status: string;
  statusSince: Date | null;
  alertedAt: Date | null;
  /** The agent who works from this number, when there is one. */
  userId?: string | null;
}

/** A number counts as down for any status that is not "ready"; "unknown" means we have not heard yet. */
export function isDown(status: string): boolean {
  return status !== 'ready' && status !== 'unknown';
}

/** These statuses cannot heal by themselves: the phone must scan a QR code again. */
export function needsScan(status: string): boolean {
  return status === 'qr_ready' || status === 'disconnected' || status === 'action_required';
}

export interface Decision { alert: WatchedNumber[]; recover: WatchedNumber[] }

export function decideNumberAlerts(numbers: WatchedNumber[], now: Date): Decision {
  const alert: WatchedNumber[] = [];
  const recover: WatchedNumber[] = [];
  for (const n of numbers) {
    if (n.status === 'ready') {
      if (n.alertedAt) recover.push(n);
      continue;
    }
    if (!isDown(n.status) || !n.statusSince) continue;
    const downFor = now.getTime() - n.statusSince.getTime();
    if (!n.alertedAt) {
      if (downFor >= GRACE_MS) alert.push(n);
    } else if (now.getTime() - n.alertedAt.getTime() >= REMINDER_MS) {
      alert.push(n);
    }
  }
  return { alert, recover };
}

/** Same rules for OpenWA itself being unreachable. */
export interface ServiceState { downSince: string | null; alertedAt: string | null }

export function decideServiceAlert(reachable: boolean, state: ServiceState, now: Date): { next: ServiceState; send: 'down' | 'back' | null } {
  if (reachable) {
    return { next: { downSince: null, alertedAt: null }, send: state.alertedAt ? 'back' : null };
  }
  const downSince = state.downSince ?? now.toISOString();
  const downFor = now.getTime() - Date.parse(downSince);
  const due = !state.alertedAt ? downFor >= GRACE_MS : now.getTime() - Date.parse(state.alertedAt) >= REMINDER_MS;
  return due
    ? { next: { downSince, alertedAt: now.toISOString() }, send: 'down' }
    : { next: { downSince, alertedAt: state.alertedAt }, send: null };
}

async function adminRecipients(): Promise<Array<{ id: string; email: string | null }>> {
  const { rows } = await db.query<{ id: string; email: string | null }>(
    `SELECT id, email FROM ipy_user WHERE is_admin = true AND is_active = true AND deleted_at IS NULL`,
  );
  return rows;
}

const LINK = '/admin/whatsapp-numbers';

/** Tell every active admin (bell, push, and email if one is connected). The slow drip uses it when it pauses itself. */
export async function alertAdmins(title: string, body: string, link: string = LINK): Promise<void> {
  await tellAdmins('down', title, body, link);
}

async function tellAdmins(kind: 'down' | 'back', title: string, body: string, link: string = LINK): Promise<void> {
  const admins = await adminRecipients();
  for (const a of admins) {
    await notify({ userId: a.id, kind: kind === 'down' ? 'whatsapp_down' : 'whatsapp_back', title, body, link })
      .catch((err) => logger.warn({ err }, 'could not notify an admin about WhatsApp'));
  }
  const emails = admins.map((a) => a.email).filter((e): e is string => Boolean(e));
  if (emails.length === 0) return;
  // Email is best effort: if the CRM has no email connected this only logs.
  await sendEmail({ to: emails, subject: title, html: `<p>${body}</p><p>Open Admin → WhatsApp numbers in the CRM.</p>`, text: body, track: false, sessionReply: true })
    .catch((err) => logger.info({ err: String(err) }, 'WhatsApp alert email not sent'));
}

interface Row { id: string; session_name: string; user_id: string | null; label: string | null; status: string; status_since: Date | null; alerted_at: Date | null }

async function checkNumbers(now: Date): Promise<void> {
  const { rows } = await db.query<Row>(`SELECT id, session_name, user_id, label, status, status_since, alerted_at FROM ipy_wa_number
      WHERE is_default OR user_id IS NOT NULL OR last_active_at IS NOT NULL`); // a spare session nobody has ever used is not an outage
  const numbers: WatchedNumber[] = rows.map((r) => ({
    id: r.id, name: r.label?.trim() || r.session_name, status: r.status, statusSince: r.status_since, alertedAt: r.alerted_at, userId: r.user_id,
  }));
  const { alert, recover } = decideNumberAlerts(numbers, now);
  for (const n of alert) {
    // Mark first, so two overlapping checks cannot both send.
    const claimed = await db.query(`UPDATE ipy_wa_number SET alerted_at = $2 WHERE id = $1 AND alerted_at IS NOT DISTINCT FROM $3 RETURNING id`, [n.id, now, n.alertedAt]);
    if (claimed.rowCount === 0) continue;
    await tellAdmins('down', `WhatsApp number "${n.name}" is down`,
      `${n.name} is ${describeSessionStatus(n.status)}. Down since ${n.statusSince?.toISOString() ?? 'a while ago'}. Messages to and from it are not flowing.`
      + (needsScan(n.status) ? ' The phone has to scan a new QR code: restarting cannot fix this.' : ''));
    // A logged-out phone can only be fixed by the person holding it, so tell that person directly.
    if (n.userId && needsScan(n.status)) {
      await notify({
        userId: n.userId, kind: 'whatsapp_down', title: 'Your WhatsApp is logged out of the CRM',
        body: 'Open Settings → My WhatsApp, press Get QR code, and scan it from WhatsApp → Linked devices → Link a device. Until then your chats cannot send or receive in the CRM.',
        link: '/settings',
      }).catch((err) => logger.warn({ err }, 'could not tell an agent their WhatsApp is logged out'));
    }
  }
  for (const n of recover) {
    const claimed = await db.query(`UPDATE ipy_wa_number SET alerted_at = NULL WHERE id = $1 AND alerted_at IS NOT NULL RETURNING id`, [n.id]);
    if (claimed.rowCount === 0) continue;
    await tellAdmins('back', `WhatsApp number "${n.name}" is back`, `${n.name} is connected again.`);
  }
}

async function readServiceState(): Promise<ServiceState> {
  const row = await db.queryOne<{ value: ServiceState }>(`SELECT value FROM ipy_setting WHERE key = $1`, [SERVICE_KEY]);
  return row?.value ?? { downSince: null, alertedAt: null };
}

/** Compare-and-swap, so two server instances cannot both claim the same transition. False means someone else got there first. */
async function claimServiceState(before: ServiceState, after: ServiceState): Promise<boolean> {
  await db.query(
    `INSERT INTO ipy_setting (key, value, category, label, updated_at) VALUES ($1, $2::jsonb, 'whatsapp', 'OpenWA service alert state', now())
     ON CONFLICT (key) DO NOTHING`,
    [SERVICE_KEY, JSON.stringify({ downSince: null, alertedAt: null })],
  );
  const done = await db.query(
    `UPDATE ipy_setting SET value = $3::jsonb, updated_at = now() WHERE key = $1 AND value = $2::jsonb RETURNING key`,
    [SERVICE_KEY, JSON.stringify(before), JSON.stringify(after)],
  );
  return (done.rowCount ?? 0) > 0;
}

/** One pass: refresh every number from OpenWA, then alert or recover. Never throws. */
export async function runNumberWatch(now: Date = new Date()): Promise<void> {
  try {
    let reachable = true;
    try { await syncFromOpenWa(); } catch (err) {
      // A key that may not list sessions is a settings matter, not an outage: say nothing about the service.
      if (err instanceof OpenWaError && (err.status === 401 || err.status === 403)) {
        logger.warn({ err: String(err) }, 'OpenWA refused the session list; the number check needs a key that may manage sessions');
        return;
      }
      reachable = false;
      logger.warn({ err: String(err) }, 'OpenWA could not be reached for the number check');
    }
    const before = await readServiceState();
    const decided = decideServiceAlert(reachable, before, now);
    if (!(await claimServiceState(before, decided.next))) return;
    if (decided.send === 'down') {
      await tellAdmins('down', 'WhatsApp service (OpenWA) is unreachable',
        'The CRM cannot reach OpenWA, so no WhatsApp chat messages are going out or coming in until it is back.');
    } else if (decided.send === 'back') {
      await tellAdmins('back', 'WhatsApp service (OpenWA) is back', 'The CRM can reach OpenWA again.');
    }
    // Numbers keep their last known status while the service is down; do not read their state as news then.
    if (reachable) await checkNumbers(now);
  } catch (err) {
    logger.warn({ err: String(err) }, 'WhatsApp number watch failed');
  }
}
