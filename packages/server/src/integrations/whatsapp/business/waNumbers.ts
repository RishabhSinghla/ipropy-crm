/**
 * The company's WhatsApp numbers: one OpenWA session per agent, plus one company default.
 *
 * The rules (also in docs/OPENWA.md):
 *  - An admin sends from any number; everybody else only from the number assigned to them.
 *  - A message goes out from the sender's chosen/own number, never silently from somebody else's.
 *  - An admin sending to an agent's lead defaults to that agent's number.
 *  - A paused number sends nothing. Customers' replies still arrive.
 *  - Re-assigning a lead never moves history: every message keeps the number that carried it
 *    (ipy_message.number_id), and new messages use the new owner's number.
 */
import { db } from '../../../db/pool.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../../utils/errors.js';
import {
  describeSessionStatus, maskPhone, openWaManage, openWaSession, OpenWaError,
} from './openwa.js';

export interface WaNumber {
  id: string;
  sessionName: string;
  sessionId: string | null;
  label: string | null;
  phone: string | null;
  userId: string | null;
  userName: string | null;
  isDefault: boolean;
  paused: boolean;
  pausedAt: string | null;
  status: string;
  statusText: string;
  lastActiveAt: string | null;
}

interface Row {
  id: string; session_name: string; session_id: string | null; label: string | null; phone: string | null;
  user_id: string | null; user_name: string | null; is_default: boolean; paused: boolean; paused_at: string | null;
  status: string; last_active_at: string | null;
}

const SELECT = `SELECT n.id, n.session_name, n.session_id, n.label, n.phone, n.user_id,
       trim(u.first_name || ' ' || u.last_name) AS user_name,
       n.is_default, n.paused, n.paused_at, n.status, n.last_active_at
  FROM ipy_wa_number n LEFT JOIN ipy_user u ON u.id = n.user_id`;

function shape(r: Row): WaNumber {
  return {
    id: r.id, sessionName: r.session_name, sessionId: r.session_id, label: r.label,
    phone: maskPhone(r.phone), userId: r.user_id, userName: r.user_name || null,
    isDefault: r.is_default, paused: r.paused, pausedAt: r.paused_at,
    status: r.status, statusText: describeSessionStatus(r.status), lastActiveAt: r.last_active_at,
  };
}

export async function listNumbers(): Promise<WaNumber[]> {
  const { rows } = await db.query<Row>(`${SELECT} ORDER BY n.is_default DESC, n.created_at`);
  return rows.map(shape);
}

/** The one number an agent works from, or null. */
export async function numberOfUser(userId: string): Promise<WaNumber | null> {
  const row = await db.queryOne<Row>(`${SELECT} WHERE n.user_id = $1`, [userId]);
  return row ? shape(row) : null;
}

export async function numberById(id: string): Promise<WaNumber | null> {
  const row = await db.queryOne<Row>(`${SELECT} WHERE n.id = $1`, [id]);
  return row ? shape(row) : null;
}

let lastLazySync = 0;

/** Which number a webhook delivery came from (OpenWA tells us its session id). */
export async function numberBySessionId(sessionId: string): Promise<{ id: string; userId: string | null } | null> {
  const find = () => db.queryOne<{ id: string; user_id: string | null }>(
    `SELECT id, user_id FROM ipy_wa_number WHERE session_id = $1`, [sessionId],
  );
  let row = await find();
  // A row created by the migration knows its session by name only; learn the id the first time it speaks.
  if (!row && Date.now() - lastLazySync > 60_000) {
    lastLazySync = Date.now();
    await syncFromOpenWa().catch(() => undefined);
    row = await find();
  }
  return row ? { id: row.id, userId: row.user_id } : null;
}

export interface NumberChoice { number: WaNumber; fallbackNote: string | null }

/**
 * A CRM that had one OpenWA session before numbers existed (or a card saved after the migration ran) has no row yet:
 * make the card's session the company number, once, so nothing that worked yesterday stops working.
 */
async function ensureCompanyNumberFromCard(): Promise<void> {
  const hasDefault = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_wa_number WHERE is_default`);
  if (hasDefault) return;
  const { getIntegrationConfig } = await import('../../../core/settings/integrations.js');
  const { OPENWA_PROVIDER } = await import('./openwa.js');
  const name = String(getIntegrationConfig(OPENWA_PROVIDER)?.sessionName ?? '').trim();
  if (!name) return;
  await db.query(
    `INSERT INTO ipy_wa_number (session_name, label, is_default) VALUES ($1, 'Company number', true)
     ON CONFLICT (session_name) DO UPDATE SET is_default = true`, [name],
  );
}

/**
 * Which number a send goes out from. Pure of side effects; the caller then checks it is ready.
 *
 *  - `requestedId` (an admin's explicit pick) wins, for admins only.
 *  - A non-admin always sends from their own number; with none, the send is refused with a clear message.
 *  - An admin with no pick: the lead owner's number, else the company default.
 */
export async function chooseNumber(input: {
  userId: string; isAdmin: boolean; requestedId?: string | null; recordOwnerId?: string | null;
}): Promise<NumberChoice> {
  await ensureCompanyNumberFromCard();
  if (input.requestedId) {
    const asked = await numberById(input.requestedId);
    if (!asked) throw new BadRequestError('That WhatsApp number does not exist any more.');
    if (!input.isAdmin && asked.userId !== input.userId) {
      throw new ForbiddenError('You can only send from your own WhatsApp number.');
    }
    return { number: asked, fallbackNote: null };
  }
  if (!input.isAdmin) {
    const own = await numberOfUser(input.userId);
    if (!own) {
      throw new BadRequestError('No WhatsApp number is assigned to you yet. Ask an admin to assign one in Admin → WhatsApp numbers.');
    }
    return { number: own, fallbackNote: null };
  }
  if (input.recordOwnerId) {
    const owners = await numberOfUser(input.recordOwnerId);
    if (owners) return { number: owners, fallbackNote: null };
  }
  const company = await db.queryOne<Row>(`${SELECT} WHERE n.is_default`);
  if (!company) throw new BadRequestError('No company WhatsApp number is set. Pick a number in Admin → WhatsApp numbers.');
  return {
    number: shape(company),
    fallbackNote: input.recordOwnerId ? 'This lead\'s agent has no WhatsApp number, so the company number was used.' : null,
  };
}

/** Refuse a paused number; the live link check happens at the provider. */
export function assertNotPaused(n: WaNumber): void {
  if (n.paused) {
    throw new BadRequestError(`The number ${n.label || n.sessionName} is paused by an admin. Nothing was sent.`);
  }
}

export async function markActive(numberId: string): Promise<void> {
  await db.query(`UPDATE ipy_wa_number SET last_active_at = now() WHERE id = $1`, [numberId]);
}

export async function rememberStatus(sessionId: string, status: string): Promise<void> {
  await db.query(`UPDATE ipy_wa_number SET status = $2 WHERE session_id = $1`, [sessionId, status]);
}

// ---------------------------------------------------------------------------
// Admin: the master screen
// ---------------------------------------------------------------------------

interface RemoteSession { id?: unknown; name?: unknown; status?: unknown; phone?: unknown }

/** Pull the live list from OpenWA into the table (adds new sessions, refreshes status/phone). Never deletes a row. */
export async function syncFromOpenWa(): Promise<WaNumber[]> {
  const remote = await openWaManage<RemoteSession[]>('/api/sessions');
  for (const s of Array.isArray(remote) ? remote : []) {
    const name = String(s.name ?? '').trim();
    if (!name) continue;
    await db.query(
      `INSERT INTO ipy_wa_number (session_name, session_id, phone, status)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_name) DO UPDATE
         SET session_id = EXCLUDED.session_id,
             phone = COALESCE(EXCLUDED.phone, ipy_wa_number.phone),
             status = EXCLUDED.status`,
      [name, String(s.id ?? ''), typeof s.phone === 'string' && s.phone ? s.phone : null, String(s.status ?? 'unknown')],
    );
  }
  return listNumbers();
}

async function mustHave(id: string): Promise<WaNumber & { sessionId: string }> {
  const n = await numberById(id);
  if (!n) throw new NotFoundError('That WhatsApp number was not found.');
  if (!n.sessionId) {
    await syncFromOpenWa();
    const again = await numberById(id);
    if (!again?.sessionId) throw new BadRequestError('OpenWA does not know this session yet. Press Refresh.');
    return again as WaNumber & { sessionId: string };
  }
  return n as WaNumber & { sessionId: string };
}

export async function createNumber(input: { sessionName: string; label?: string; webhookUrl?: string }): Promise<WaNumber> {
  const name = input.sessionName.trim();
  if (!/^[A-Za-z0-9-]{2,40}$/.test(name)) {
    throw new BadRequestError('Use 2–40 letters, numbers or hyphens for the session name (for example shikha-phone).');
  }
  let created: RemoteSession;
  try {
    created = await openWaManage<RemoteSession>('/api/sessions', { method: 'POST', body: { name } });
  } catch (err) {
    if (err instanceof OpenWaError && err.status === 409) {
      throw new BadRequestError('OpenWA already has a session with that name. Press Refresh to bring it in.');
    }
    throw err;
  }
  await db.query(
    `INSERT INTO ipy_wa_number (session_name, session_id, label, status)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (session_name) DO UPDATE SET session_id = EXCLUDED.session_id, label = COALESCE(EXCLUDED.label, ipy_wa_number.label)`,
    [name, String(created.id ?? ''), input.label?.trim() || null, String(created.status ?? 'created')],
  );
  const row = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_wa_number WHERE session_name = $1`, [name]);
  if (input.webhookUrl) await connectWebhook(row!.id, input.webhookUrl).catch(() => undefined);
  return (await numberById(row!.id))!;
}

/** Point this session's events at the CRM, with the shared secret already saved on the card. */
export async function connectWebhook(id: string, url: string): Promise<void> {
  const { getIntegrationCredentials } = await import('../../../core/settings/integrations.js');
  const { OPENWA_PROVIDER } = await import('./openwa.js');
  const secret = (getIntegrationCredentials(OPENWA_PROVIDER)?.webhookSecret ?? '').trim();
  if (!secret) throw new BadRequestError('Generate the webhook secret on the OpenWA card first.');
  const n = await mustHave(id);
  await openWaManage(`/api/sessions/${n.sessionId}/webhooks`, {
    method: 'POST',
    body: { url, secret, events: ['message.received', 'message.sent', 'message.ack', 'message.failed', 'session.status'] },
  });
}

export async function controlSession(id: string, action: 'start' | 'stop' | 'restart' | 'unlink'): Promise<WaNumber> {
  const n = await mustHave(id);
  if (action === 'restart') {
    await openWaManage(`/api/sessions/${n.sessionId}/stop`, { method: 'POST' }).catch(() => undefined);
    await openWaManage(`/api/sessions/${n.sessionId}/start`, { method: 'POST' });
  } else if (action === 'unlink') {
    await openWaManage(`/api/sessions/${n.sessionId}/logout`, { method: 'POST' });
  } else {
    await openWaManage(`/api/sessions/${n.sessionId}/${action}`, { method: 'POST' });
  }
  const live = await openWaSession({ fresh: true, name: n.sessionName }).catch(() => null);
  if (live) await db.query(`UPDATE ipy_wa_number SET status = $2, phone = COALESCE($3, phone) WHERE id = $1`, [id, live.status, live.phone]);
  return (await numberById(id))!;
}

/** The QR picture (a data URL) for pairing a phone. */
export async function qrFor(id: string): Promise<{ qrCode: string | null; status: string }> {
  const n = await mustHave(id);
  try {
    const out = await openWaManage<{ qrCode?: string; status?: string }>(`/api/sessions/${n.sessionId}/qr`);
    return { qrCode: out.qrCode ?? null, status: out.status ?? 'qr_ready' };
  } catch (err) {
    // OpenWA answers 400 when there is no QR to show (already linked, or not started yet).
    if (err instanceof OpenWaError && err.status === 400) {
      const live = await openWaSession({ fresh: true, name: n.sessionName }).catch(() => null);
      return { qrCode: null, status: live?.status ?? n.status };
    }
    throw err;
  }
}

export async function assignNumber(id: string, userId: string | null): Promise<WaNumber> {
  await mustExist(id);
  if (userId) {
    const user = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_user WHERE id = $1`, [userId]);
    if (!user) throw new BadRequestError('That user does not exist.');
    // One number per agent: the number they had before is released, not deleted.
    await db.query(`UPDATE ipy_wa_number SET user_id = NULL WHERE user_id = $1 AND id <> $2`, [userId, id]);
  }
  await db.query(`UPDATE ipy_wa_number SET user_id = $2 WHERE id = $1`, [id, userId]);
  return (await numberById(id))!;
}

export async function setDefaultNumber(id: string): Promise<WaNumber> {
  await mustExist(id);
  await db.query(`UPDATE ipy_wa_number SET is_default = (id = $1)`, [id]);
  return (await numberById(id))!;
}

export async function setPaused(id: string, paused: boolean, byUserId: string): Promise<WaNumber> {
  await mustExist(id);
  await db.query(
    `UPDATE ipy_wa_number SET paused = $2, paused_at = CASE WHEN $2::boolean THEN now() ELSE NULL END,
            paused_by = CASE WHEN $2::boolean THEN $3::uuid ELSE NULL END WHERE id = $1`,
    [id, paused, byUserId],
  );
  return (await numberById(id))!;
}

export async function updateLabel(id: string, label: string): Promise<WaNumber> {
  await mustExist(id);
  await db.query(`UPDATE ipy_wa_number SET label = $2 WHERE id = $1`, [id, label.trim() || null]);
  return (await numberById(id))!;
}

async function mustExist(id: string): Promise<void> {
  const row = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_wa_number WHERE id = $1`, [id]);
  if (!row) throw new NotFoundError('That WhatsApp number was not found.');
}
