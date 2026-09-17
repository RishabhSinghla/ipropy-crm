import makeWASocket, {
  Browsers, DisconnectReason, makeCacheableSignalKeyStore,
  type WASocket, type WAMessage,
} from '@whiskeysockets/baileys';
import type { Boom } from '@hapi/boom';
import { db } from '../../../db/pool.js';
import { logger } from '../../../utils/logger.js';
import { loadAuthState } from './authState.js';
import type { WhatsAppConnectionStatus } from '../providers/types.js';

/**
 * One linked device per agent, and the socket that keeps it alive.
 *
 * Everything here is keyed by account id and nothing is shared between
 * accounts. That is the whole point: the previous build picked a session with
 * `ORDER BY last_connected_at DESC LIMIT 1`, so a message Sheetal typed could
 * leave from Rahul's phone. There is no "current" socket in this file.
 *
 * Three things learned the hard way and encoded here rather than in a comment
 * somewhere else:
 *
 *   * **History arrives exactly once**, in the handshake after a scan, and can
 *     never be asked for again. It comes on `messaging-history.set`, never on
 *     `messages.upsert`.
 *   * **History must not touch the live path.** Replaying it through the
 *     inbound handler would auto-reply to every customer about something they
 *     said months ago. The two events have separate handlers here and the
 *     history one cannot reach the live one.
 *   * **Baileys must be on the `latest` dist-tag.** A client a year old is
 *     refused the moment it asks for a full sync, and it presents as an endless
 *     428 with no QR ever appearing — which reads as "the QR is broken".
 */

export interface LiveMessage {
  accountId: string;
  /** The other party, as WhatsApp gives it: `9198…@s.whatsapp.net`. */
  jid: string;
  providerMessageId: string;
  fromMe: boolean;
  timestamp: Date;
  text: string | null;
  raw: WAMessage;
}

export interface HistoryConversation {
  accountId: string;
  jid: string;
  messages: WAMessage[];
}

type Handlers = {
  onLive: (message: LiveMessage) => Promise<void>;
  onHistory: (conversation: HistoryConversation) => Promise<void>;
  onStatus: (accountId: string, status: WhatsAppConnectionStatus) => Promise<void>;
};

let handlers: Handlers | null = null;

/** Wired once at boot by the service, so this file never imports the CRM back. */
export function setHandlers(next: Handlers): void {
  handlers = next;
}

interface LiveSession {
  socket: WASocket;
  qr: string | null;
  status: WhatsAppConnectionStatus;
  /** Stops a reconnect loop racing a deliberate disconnect. */
  closing: boolean;
}

const sessions = new Map<string, LiveSession>();

async function record(accountId: string, event: string, level: 'info' | 'warn' | 'error', detail?: unknown): Promise<void> {
  // Connection health only. Never a message body: this table is read by admins
  // who have no business seeing what a customer said.
  await db.query(
    `INSERT INTO ipy_wa_event (account_id, event, level, detail) VALUES ($1,$2,$3,$4)`,
    [accountId, event, level, detail ? JSON.stringify(detail) : null],
  ).catch((err) => logger.warn({ err, accountId, event }, 'could not record a WhatsApp event'));
}

async function setStatus(accountId: string, status: WhatsAppConnectionStatus, error?: string): Promise<void> {
  const session = sessions.get(accountId);
  if (session) session.status = status;
  await db.query(
    `UPDATE ipy_wa_account
        SET status = $2,
            last_error = $3,
            last_connected_at = CASE WHEN $2 = 'connected' THEN now() ELSE last_connected_at END,
            updated_at = now()
      WHERE id = $1`,
    [accountId, status, error ?? null],
  );
  await handlers?.onStatus(accountId, status);
}

/** The readable text of a message, whatever shape WhatsApp wrapped it in. */
export function textOf(message: WAMessage): string | null {
  const m = message.message;
  if (!m) return null;
  return m.conversation
    ?? m.extendedTextMessage?.text
    ?? m.imageMessage?.caption
    ?? m.videoMessage?.caption
    ?? m.documentMessage?.caption
    ?? null;
}

export function statusOf(accountId: string): WhatsAppConnectionStatus {
  return sessions.get(accountId)?.status ?? 'disconnected';
}

export function qrFor(accountId: string): string | null {
  return sessions.get(accountId)?.qr ?? null;
}

export async function connect(accountId: string): Promise<void> {
  const existing = sessions.get(accountId);
  if (existing && !existing.closing && existing.status === 'connected') return;

  const auth = await loadAuthState(accountId);
  await setStatus(accountId, 'connecting');

  const socket = makeWASocket({
    auth: {
      creds: auth.state.creds,
      // Cached, because Baileys asks for the same signal keys repeatedly during
      // a handshake and every miss would otherwise be a database round trip.
      keys: makeCacheableSignalKeyStore(auth.state.keys as never, logger as never),
    },
    // Named honestly. Pretending to be a phone is the sort of thing that gets
    // an account banned, and it is explicitly out of scope.
    browser: Browsers.appropriate('iPropy CRM'),
    // The CRM decides who gets read receipts, per conversation, when somebody
    // actually opens it — not the socket on the agent's behalf.
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  const session: LiveSession = { socket, qr: null, status: 'connecting', closing: false };
  sessions.set(accountId, session);

  socket.ev.on('creds.update', () => { void auth.saveCreds(); });

  socket.ev.on('connection.update', (update) => {
    void (async () => {
      if (update.qr) {
        session.qr = update.qr;
        await setStatus(accountId, 'qr');
        return;
      }
      if (update.connection === 'open') {
        session.qr = null;
        const jid = socket.user?.id ?? null;
        await db.query(
          `UPDATE ipy_wa_account
              SET phone_number = COALESCE($2, phone_number), display_name = COALESCE($3, display_name),
                  last_seen_at = now(), updated_at = now()
            WHERE id = $1`,
          [accountId, jid ? `+${jid.split(':')[0]?.split('@')[0]}` : null, socket.user?.name ?? null],
        );
        await setStatus(accountId, 'connected');
        await record(accountId, 'connected', 'info');
        return;
      }
      if (update.connection === 'close') {
        const reason = (update.lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const loggedOut = reason === DisconnectReason.loggedOut;
        sessions.delete(accountId);

        if (loggedOut) {
          /*
            The person unlinked this device on their phone, or WhatsApp did.
            Reconnecting would be trying to defeat a logout, which is exactly
            what this build does not do: the stored keys go and the agent is
            asked to scan again.

            What must survive is everything already synchronised. `clear` only
            touches the account row.
          */
          await auth.clear();
          await setStatus(accountId, 'disconnected', 'WhatsApp disconnected — reconnect required.');
          await record(accountId, 'logged_out', 'warn', { reason });
          return;
        }

        if (session.closing) return;
        await setStatus(accountId, 'error', 'Connection interrupted; reconnecting.');
        await record(accountId, 'connection_lost', 'warn', { reason });
        // One attempt, after a pause. A tight loop against a service that is
        // refusing us is how an account gets rate-limited into a real ban.
        setTimeout(() => { void connect(accountId).catch(() => undefined); }, 5_000);
      }
    })().catch((err) => logger.error({ err, accountId }, 'WhatsApp connection update failed'));
  });

  /*
    Live traffic only. `type: 'notify'` is WhatsApp telling us something has just
    happened; an 'append' is the socket filling in its own backlog and must not
    be treated as news, or every reconnect would re-announce old messages to the
    team and to any automation listening.
  */
  socket.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify' || !handlers) return;
    void (async () => {
      for (const message of messages) {
        const id = message.key?.id;
        const jid = message.key?.remoteJid;
        if (!id || !jid || jid === 'status@broadcast') continue;
        await handlers.onLive({
          accountId,
          jid,
          providerMessageId: id,
          fromMe: Boolean(message.key?.fromMe),
          timestamp: new Date(Number(message.messageTimestamp ?? Date.now() / 1000) * 1000),
          text: textOf(message),
          raw: message,
        });
      }
    })().catch((err) => logger.error({ err, accountId }, 'WhatsApp inbound failed'));
  });

  /*
    History, and it arrives once. Handed to a different handler on purpose:
    anything that replies, notifies or scores lives on the live path, and this
    must never reach it. A rep scanning a QR should not fire a hundred
    auto-replies about conversations from March.
  */
  socket.ev.on('messaging-history.set', ({ messages }) => {
    if (!handlers || !messages?.length) return;
    const byJid = new Map<string, WAMessage[]>();
    for (const message of messages) {
      const jid = message.key?.remoteJid;
      if (!jid || jid === 'status@broadcast') continue;
      byJid.set(jid, [...(byJid.get(jid) ?? []), message]);
    }
    void (async () => {
      for (const [jid, list] of byJid) {
        await handlers!.onHistory({ accountId, jid, messages: list });
      }
      await db.query(`UPDATE ipy_wa_account SET last_synced_at = now() WHERE id = $1`, [accountId]);
      await record(accountId, 'history_synced', 'info', { conversations: byJid.size });
    })().catch((err) => logger.error({ err, accountId }, 'WhatsApp history sync failed'));
  });
}

export async function disconnect(accountId: string): Promise<void> {
  const session = sessions.get(accountId);
  if (session) {
    session.closing = true;
    try { await session.socket.logout(); } catch { /* already gone */ }
    sessions.delete(accountId);
  }
  const auth = await loadAuthState(accountId);
  await auth.clear();
  await record(accountId, 'disconnected_by_user', 'info');
}

export async function sendText(accountId: string, jid: string, text: string): Promise<string> {
  const session = sessions.get(accountId);
  if (!session || session.status !== 'connected') {
    throw new Error('That WhatsApp account is not connected. Reconnect it and try again.');
  }
  const sent = await session.socket.sendMessage(jid, { text });
  const id = sent?.key?.id;
  if (!id) throw new Error('WhatsApp accepted the message but returned no id.');
  return id;
}

/** Bring back every account that was connected before the process restarted. */
export async function restoreConnections(): Promise<void> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM ipy_wa_account
      WHERE is_enabled AND auth_state_encrypted IS NOT NULL AND status <> 'disconnected'`,
  );
  for (const row of rows) {
    await connect(row.id).catch((err) => logger.warn({ err, accountId: row.id }, 'could not restore a WhatsApp session'));
  }
}
