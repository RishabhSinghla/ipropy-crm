import { db } from '../../../db/pool.js';
import { logger } from '../../../utils/logger.js';
import * as session from './session.js';
import { recordHistory, recordLive, recordOutbound } from './store.js';
import { handleFromJid, matchContact } from './matchContact.js';
import type { WhatsAppConnectionStatus } from '../providers/types.js';

/**
 * The CRM's side of agent-linked WhatsApp.
 *
 * Every function here takes the **user**, never an account id from the client.
 * That is the isolation rule made unavoidable rather than remembered: there is
 * no call an agent can make that names somebody else's account, so Sheetal's
 * message cannot leave from Rahul's phone even if a request says it should.
 */

export interface AgentAccountView {
  id: string;
  label: string;
  phoneNumber: string | null;
  displayName: string | null;
  status: WhatsAppConnectionStatus;
  isEnabled: boolean;
  lastConnectedAt: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
}

interface Row {
  id: string; label: string; phone_number: string | null; display_name: string | null;
  status: WhatsAppConnectionStatus; is_enabled: boolean;
  last_connected_at: string | null; last_synced_at: string | null; last_error: string | null;
}

function view(row: Row): AgentAccountView {
  return {
    id: row.id,
    label: row.label,
    phoneNumber: row.phone_number,
    displayName: row.display_name,
    // The socket is the truth while the process is up; the column is what
    // survives a restart. Disagreeing with the live socket would show
    // "connected" to somebody whose session died a minute ago.
    status: session.statusOf(row.id) === 'disconnected' ? row.status : session.statusOf(row.id),
    isEnabled: row.is_enabled,
    lastConnectedAt: row.last_connected_at,
    lastSyncedAt: row.last_synced_at,
    lastError: row.last_error,
  };
}

async function rowFor(userId: string): Promise<Row | null> {
  return db.queryOne<Row>(
    `SELECT id, label, phone_number, display_name, status, is_enabled,
            last_connected_at, last_synced_at, last_error
       FROM ipy_wa_account WHERE user_id = $1`,
    [userId],
  );
}

/** This agent's account, or null when they have never linked one. */
export async function myAccount(userId: string): Promise<AgentAccountView | null> {
  const row = await rowFor(userId);
  return row ? view(row) : null;
}

/**
 * Begin linking, and hand back the QR when WhatsApp offers one.
 *
 * Creating the row and connecting are one call because a row with no session is
 * a dead entry somebody has to clean up, and every previous build accumulated
 * them.
 */
export async function startLink(userId: string, label: string): Promise<{ account: AgentAccountView; qr: string | null }> {
  let row = await rowFor(userId);
  if (!row) {
    row = await db.queryOne<Row>(
      `INSERT INTO ipy_wa_account (user_id, label)
       VALUES ($1, $2)
       RETURNING id, label, phone_number, display_name, status, is_enabled,
                 last_connected_at, last_synced_at, last_error`,
      [userId, label.trim() || 'My WhatsApp'],
    );
  }
  if (!row) throw new Error('Could not create a WhatsApp link for this account.');
  if (!row.is_enabled) throw new Error('An administrator has switched off WhatsApp for your account.');

  await session.connect(row.id);
  const fresh = await rowFor(userId);
  return { account: view(fresh ?? row), qr: session.qrFor(row.id) };
}

/** The QR, while WhatsApp is offering one. Polled by the link screen. */
export async function linkState(userId: string): Promise<{ account: AgentAccountView | null; qr: string | null }> {
  const row = await rowFor(userId);
  if (!row) return { account: null, qr: null };
  return { account: view(row), qr: session.qrFor(row.id) };
}

/**
 * Unlink, keeping every message.
 *
 * The account row stays so the timeline can still say who sent what; only the
 * session goes. Deleting the row would be allowed too — the foreign keys are
 * ON DELETE SET NULL — but unlinking is not leaving the company.
 */
export async function unlink(userId: string): Promise<void> {
  const row = await rowFor(userId);
  if (!row) return;
  await session.disconnect(row.id);
}

/**
 * Send as this agent, from this agent's own number.
 *
 * Refuses rather than falling back to another account. A message that quietly
 * leaves from a colleague's phone is worse than one that does not leave.
 */
export async function sendAsAgent(input: {
  userId: string;
  to: string;
  text: string;
}): Promise<{ providerMessageId: string }> {
  const row = await rowFor(input.userId);
  if (!row) throw new Error('Link your WhatsApp in My Profile before sending.');
  if (!row.is_enabled) throw new Error('An administrator has switched off WhatsApp for your account.');

  const handle = handleFromJid(input.to) ?? (input.to.startsWith('+') ? input.to : `+${input.to.replace(/\D/g, '')}`);
  const digits = handle.replace(/\D/g, '');
  if (digits.length < 10) throw new Error('That does not look like a mobile number.');

  const providerMessageId = await session.sendText(row.id, `${digits}@s.whatsapp.net`, input.text);

  const match = await matchContact('leads', handle);
  await recordOutbound({
    accountId: row.id,
    userId: input.userId,
    handle,
    recordId: match.kind === 'one' ? match.recordId : null,
    providerMessageId,
    text: input.text,
  });
  return { providerMessageId };
}

/**
 * Wire the socket layer to the CRM, once, at boot.
 *
 * The two message paths stay separate all the way down: live traffic can
 * notify, history cannot reach anything that does.
 */
export function init(): void {
  session.setHandlers({
    onLive: recordLive,
    onHistory: recordHistory,
    async onStatus(accountId, status) {
      logger.debug({ accountId, status }, 'WhatsApp account status');
    },
  });
}

export async function restore(): Promise<void> {
  await session.restoreConnections();
}
