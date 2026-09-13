/**
 * WhatsApp Web connector.
 *
 * This module is intentionally separate from `integrations/whatsapp/provider`:
 * that file is Meta's official Cloud API. A Web account is an opt-in linked
 * business phone with its own encrypted auth state and lifecycle.
 */
import makeWASocket, {
  BufferJSON, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, proto,
  type AuthenticationCreds, type SignalDataSet, type SignalKeyStore, type WASocket, type WAMessage,
} from '@whiskeysockets/baileys';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { db } from '../../db/pool.js';
import { makeSecretBox } from '../../core/secretbox.js';
import { logger } from '../../utils/logger.js';
import { BadRequestError, NotFoundError } from '../../utils/errors.js';
import * as conversations from '../whatsapp/service.js';

type StoredState = { creds: AuthenticationCreds; keys: Record<string, Record<string, unknown>> };
type AccountStatus = 'disconnected' | 'connecting' | 'qr' | 'pairing' | 'connected' | 'error';

export interface WebAccount {
  id: string; label: string; phoneNumber: string | null; displayName: string | null;
  status: AccountStatus; lastConnectedAt: string | null; lastError: string | null;
  createdAt: string; updatedAt: string;
}

const box = makeSecretBox('ipropy:whatsapp-web:auth:v1');
const sockets = new Map<string, WASocket>();
const qrCodes = new Map<string, string>();
const reconnectAttempts = new Map<string, number>();

function normaliseNumber(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return digits;
  throw new BadRequestError('Enter a valid mobile number, including its country code when it is not Indian.');
}

function accountRow(row: Record<string, unknown>): WebAccount {
  return {
    id: String(row.id), label: String(row.label), phoneNumber: row.phone_number as string | null,
    displayName: row.display_name as string | null, status: row.status as AccountStatus,
    lastConnectedAt: row.last_connected_at as string | null, lastError: row.last_error as string | null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

async function log(accountId: string, event: string, level: 'info' | 'warn' | 'error' = 'info', detail?: Record<string, unknown>): Promise<void> {
  await db.query(
    `INSERT INTO ipy_whatsapp_web_log (account_id, event, level, detail) VALUES ($1,$2,$3,$4)`,
    [accountId, event, level, detail ? JSON.stringify(detail) : null],
  ).catch((err) => logger.warn({ err, accountId, event }, 'could not write WhatsApp Web audit log'));
}

async function requireAccount(id: string): Promise<Record<string, unknown>> {
  const row = await db.queryOne<Record<string, unknown>>(`SELECT * FROM ipy_whatsapp_web_account WHERE id = $1`, [id]);
  if (!row) throw new NotFoundError('WhatsApp Web account not found');
  return row;
}

async function authState(accountId: string, encrypted: string | null): Promise<{ state: { creds: AuthenticationCreds; keys: SignalKeyStore }; save: () => Promise<void> }> {
  let stored: StoredState;
  try {
    const plain = box.decrypt(encrypted);
    stored = plain ? JSON.parse(plain, BufferJSON.reviver) as StoredState : { creds: initAuthCreds(), keys: {} };
  } catch {
    stored = { creds: initAuthCreds(), keys: {} };
  }
  stored.creds ??= initAuthCreds();
  stored.keys ??= {};

  const save = async () => {
    const payload = JSON.stringify(stored, BufferJSON.replacer);
    await db.query(`UPDATE ipy_whatsapp_web_account SET auth_state_encrypted = $2, updated_at = now() WHERE id = $1`, [accountId, box.encrypt(payload)]);
  };
  const keys: SignalKeyStore = {
    get: async (type, ids) => {
      const result: Record<string, unknown> = {};
      for (const id of ids) {
        let value = stored.keys[type]?.[id];
        if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
        if (value) result[id] = value;
      }
      return result as never;
    },
    set: async (data: SignalDataSet) => {
      for (const [type, entries] of Object.entries(data)) {
        stored.keys[type] ??= {};
        for (const [id, value] of Object.entries(entries ?? {})) {
          if (value === null || value === undefined) delete stored.keys[type]![id];
          else stored.keys[type]![id] = value;
        }
      }
      await save();
    },
  };
  return { state: { creds: stored.creds, keys }, save };
}

export async function listAccounts(): Promise<WebAccount[]> {
  const result = await db.query<Record<string, unknown>>(`SELECT * FROM ipy_whatsapp_web_account ORDER BY created_at ASC`);
  return result.rows.map(accountRow);
}

/** Resume only accounts that were explicitly connected before a server restart. */
export async function restoreConnections(): Promise<void> {
  const rows = await db.query<{ id: string }>(`SELECT id FROM ipy_whatsapp_web_account WHERE status IN ('connected','connecting','qr','pairing')`);
  for (const row of rows.rows) {
    void connect(row.id).catch((err) => logger.error({ err, accountId: row.id }, 'could not restore WhatsApp Web session'));
  }
}

export async function createAccount(input: { label: string; createdBy: string }): Promise<WebAccount> {
  const row = await db.queryOne<Record<string, unknown>>(
    `INSERT INTO ipy_whatsapp_web_account (label, created_by) VALUES ($1,$2) RETURNING *`, [input.label.trim(), input.createdBy],
  );
  await log(String(row!.id), 'account_created');
  return accountRow(row!);
}

export async function getQr(accountId: string): Promise<{ status: AccountStatus; qr: string | null }> {
  const account = await requireAccount(accountId);
  return { status: account.status as AccountStatus, qr: qrCodes.get(accountId) ?? null };
}

export async function connect(accountId: string): Promise<void> {
  const account = await requireAccount(accountId);
  const existing = sockets.get(accountId);
  if (existing) return;

  await db.query(`UPDATE ipy_whatsapp_web_account SET status = 'connecting', last_error = NULL, updated_at = now() WHERE id = $1`, [accountId]);
  const auth = await authState(accountId, account.auth_state_encrypted as string | null);
  const latest = await fetchLatestBaileysVersion().catch(() => null);
  const socket = makeWASocket({
    auth: auth.state,
    ...(latest ? { version: latest.version } : {}),
    browser: ['iPROPY CRM', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldIgnoreJid: (jid) => jid.endsWith('@g.us') || jid.endsWith('@broadcast'),
  });
  sockets.set(accountId, socket);

  socket.ev.on('creds.update', () => void auth.save().catch((err) => logger.error({ err, accountId }, 'could not persist WhatsApp Web auth state')));
  socket.ev.on('connection.update', (update) => {
    void handleConnectionUpdate(accountId, socket, auth.save, update).catch((err) => logger.error({ err, accountId }, 'WhatsApp Web connection update failed'));
  });
  socket.ev.on('messages.upsert', (event) => {
    if (event.type !== 'notify') return;
    for (const message of event.messages) void receiveMessage(accountId, message).catch((err) => logger.error({ err, accountId }, 'WhatsApp Web inbound message failed'));
  });
  socket.ev.on('messages.update', (updates) => {
    for (const { key, update } of updates) {
      if (!key.id || typeof update.status !== 'number') continue;
      // Baileys uses WebMessageInfo acknowledgement values. We store the
      // human-facing state already used by the Meta connector, so timeline
      // receipts behave identically whichever WhatsApp channel sent it.
      const status = update.status === 5 ? 'failed'
        : update.status >= 3 ? 'read'
          : update.status === 2 ? 'delivered'
            : update.status === 1 ? 'sent' : null;
      if (status) void conversations.handleStatusUpdate(key.id, status).catch((err) => logger.warn({ err, accountId, messageId: key.id }, 'could not store WhatsApp Web receipt'));
    }
  });
  await log(accountId, 'connect_started');
}

async function handleConnectionUpdate(accountId: string, socket: WASocket, save: () => Promise<void>, update: Record<string, unknown>): Promise<void> {
  if (typeof update.qr === 'string') {
    qrCodes.set(accountId, await QRCode.toDataURL(update.qr, { margin: 1, width: 300 }));
    await db.query(`UPDATE ipy_whatsapp_web_account SET status = 'qr', updated_at = now() WHERE id = $1`, [accountId]);
    await log(accountId, 'qr_ready');
  }
  if (update.connection === 'open') {
    const me = socket.authState.creds.me;
    const phone = me?.id ? `+${me.id.split(':')[0]!.split('@')[0]!.replace(/\D/g, '')}` : null;
    qrCodes.delete(accountId); reconnectAttempts.delete(accountId);
    await save();
    await db.query(
      `UPDATE ipy_whatsapp_web_account SET status = 'connected', phone_number = COALESCE($2, phone_number), display_name = $3, last_connected_at = now(), last_error = NULL, updated_at = now() WHERE id = $1`,
      [accountId, phone, me?.name ?? null],
    );
    await log(accountId, 'connected', 'info', { phone });
  }
  if (update.connection === 'close') {
    sockets.delete(accountId); qrCodes.delete(accountId);
    const code = (update.lastDisconnect as { error?: { output?: { statusCode?: number } } } | undefined)?.error?.output?.statusCode;
    if (code === DisconnectReason.loggedOut) {
      await db.query(`UPDATE ipy_whatsapp_web_account SET status = 'disconnected', auth_state_encrypted = NULL, last_error = 'Session logged out', updated_at = now() WHERE id = $1`, [accountId]);
      await log(accountId, 'logged_out', 'warn');
      return;
    }
    const tries = (reconnectAttempts.get(accountId) ?? 0) + 1;
    reconnectAttempts.set(accountId, tries);
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(tries, 6));
    await db.query(`UPDATE ipy_whatsapp_web_account SET status = 'error', last_error = 'Connection interrupted; reconnecting automatically.', updated_at = now() WHERE id = $1`, [accountId]);
    await log(accountId, 'connection_closed', 'warn', { code, retryInMs: delay });
    setTimeout(() => void connect(accountId).catch((err) => logger.error({ err, accountId }, 'WhatsApp Web reconnect failed')), delay).unref();
  }
}

async function receiveMessage(accountId: string, message: WAMessage): Promise<void> {
  if (!message.message || !message.key.remoteJid?.endsWith('@s.whatsapp.net') || !message.key.id) return;
  const from = `+${message.key.remoteJid.split('@')[0]!.replace(/\D/g, '')}`;
  const content = message.message;
  const text = content.conversation ?? content.extendedTextMessage?.text ?? content.imageMessage?.caption ?? content.documentMessage?.caption;
  const location = content.locationMessage ? { latitude: content.locationMessage.degreesLatitude ?? 0, longitude: content.locationMessage.degreesLongitude ?? 0, name: content.locationMessage.name ?? undefined } : undefined;
  const type = content.imageMessage ? 'image' : content.documentMessage ? 'document' : content.locationMessage ? 'location' : 'text';
  // `fromMe` covers messages sent directly from the linked phone. Keeping
  // those in the same thread is what makes this a real WhatsApp Web sync,
  // rather than an inbound-only bridge. CRM-originated sends are de-duplicated
  // by their provider message id in the conversation service.
  if (message.key.fromMe) {
    await conversations.handleWebOutbound({
      from, providerMessageId: message.key.id, type, text: text ?? undefined, location,
      mimeType: content.imageMessage?.mimetype ?? content.documentMessage?.mimetype ?? undefined,
      filename: content.documentMessage?.fileName ?? undefined,
      timestamp: typeof message.messageTimestamp === 'number' ? message.messageTimestamp : undefined,
      provider: 'web', webAccountId: accountId,
    });
    return;
  }
  await conversations.handleInbound({
    from, providerMessageId: message.key.id, type, text: text ?? undefined, location,
    mimeType: content.imageMessage?.mimetype ?? content.documentMessage?.mimetype ?? undefined,
    filename: content.documentMessage?.fileName ?? undefined,
    timestamp: typeof message.messageTimestamp === 'number' ? message.messageTimestamp : undefined,
    provider: 'web', webAccountId: accountId,
  });
}

export async function requestPairingCode(accountId: string, number: string): Promise<{ code: string }> {
  await connect(accountId);
  const socket = sockets.get(accountId);
  if (!socket) throw new BadRequestError('WhatsApp Web connector is starting. Try again in a moment.');
  const code = await socket.requestPairingCode(normaliseNumber(number));
  await db.query(`UPDATE ipy_whatsapp_web_account SET status = 'pairing', updated_at = now() WHERE id = $1`, [accountId]);
  await log(accountId, 'pairing_code_requested');
  return { code };
}

export async function disconnect(accountId: string): Promise<void> {
  await requireAccount(accountId);
  reconnectAttempts.delete(accountId); qrCodes.delete(accountId);
  const socket = sockets.get(accountId);
  sockets.delete(accountId);
  await socket?.logout().catch(() => undefined);
  await db.query(`UPDATE ipy_whatsapp_web_account SET status = 'disconnected', auth_state_encrypted = NULL, phone_number = NULL, display_name = NULL, updated_at = now() WHERE id = $1`, [accountId]);
  await log(accountId, 'disconnected');
}

export async function send(accountId: string, input: { to: string; text?: string; media?: { type: 'image' | 'document' | 'audio' | 'video'; link: string; caption?: string; filename?: string }; location?: { latitude: number; longitude: number; name?: string } }): Promise<{ providerMessageId: string; status: 'sent' }> {
  const socket = sockets.get(accountId);
  if (!socket) throw new BadRequestError('This WhatsApp Web account is not connected.');
  const jid = `${normaliseNumber(input.to)}@s.whatsapp.net`;
  const payload = input.location ? { location: { degreesLatitude: input.location.latitude, degreesLongitude: input.location.longitude, name: input.location.name } }
    : input.media?.type === 'image' ? { image: { url: input.media.link }, caption: input.media.caption }
      : input.media?.type === 'document' ? { document: { url: input.media.link }, mimetype: 'application/octet-stream', fileName: input.media.filename ?? 'document', caption: input.media.caption }
        : input.media?.type === 'audio' ? { audio: { url: input.media.link } }
          : input.media?.type === 'video' ? { video: { url: input.media.link }, caption: input.media.caption }
            : { text: input.text ?? '' };
  const sent = await socket.sendMessage(jid, payload);
  const id = sent?.key.id ?? crypto.randomUUID();
  await log(accountId, 'message_sent', 'info', { id });
  return { providerMessageId: id, status: 'sent' };
}
