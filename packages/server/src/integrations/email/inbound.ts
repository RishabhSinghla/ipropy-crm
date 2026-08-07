/**
 * Inbound email sync over IMAP.
 *
 * Polls the configured mailbox for unseen messages and writes them into
 * `ipy_email_log` with direction = 'inbound' so they show up in the record
 * timeline and the lead inbox. Messages are matched to a CRM record by the
 * sender's email address (resolved generically through the metadata registry,
 * so it works for leads, organisations and any module that carries an
 * email-typed field); a reply that references one of our own outbound
 * messages is attached to that message's record instead.
 *
 * Graceful degradation is the same contract as the rest of the product:
 * no IMAP credentials configured means this is a no-op that never throws.
 * Message-ids make the sync idempotent — re-running a poll never duplicates.
 */
import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { getSettings } from '../../core/settings/integrations.js';
import { registry } from '../../core/metadata/registry.js';
import { fieldExpr, quoteIdent } from '../../core/query/builder.js';
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';

export interface InboundSyncResult {
  checked: number;
  imported: number;
  matched: number;
  skipped: number;
  errors: string[];
}

export function isImapConfigured(): boolean {
  const imap = getSettings().email.imap;
  return Boolean(imap.host && imap.user && imap.password);
}

/** Lightweight connectivity check for the admin "Test connection" button. */
export async function testImapConnection(): Promise<{ ok: boolean; error?: string; unseen?: number }> {
  const imap = getSettings().email.imap;
  if (!imap.host) return { ok: false, error: 'IMAP host is required.' };
  const client = imapClient();
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const unseen = await client.search({ seen: false }, { uid: true });
      return { ok: true, unseen: (unseen || []).length };
    } finally {
      lock.release();
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await client.logout().catch(() => {});
  }
}

function imapClient(): ImapFlow {
  const { host, port, user, password } = getSettings().email.imap;
  return new ImapFlow({
    host,
    port: port || 993,
    secure: (port || 993) === 993,
    auth: { user, pass: password },
    logger: false,
  });
}

export interface SyncOptions {
  /** Max messages to pull in one pass. */
  max?: number;
}

export async function syncInboundEmails(options: SyncOptions = {}): Promise<InboundSyncResult> {
  const result: InboundSyncResult = { checked: 0, imported: 0, matched: 0, skipped: 0, errors: [] };
  if (!isImapConfigured()) return result;

  const client = imapClient();
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const unseen = await client.search({ seen: false }, { uid: true });
      const uids = (unseen || []).slice(0, options.max ?? 25);
      if (!uids.length) return result;

      // Best-effort resolution of email -> record and outbound thread maps up
      // front so the per-message work stays cheap.
      const byEmail = await indexRecordsByEmail();
      const byThread = await indexOutboundThreads();

      const messages = client.fetch(uids, {
        uid: true,
        envelope: true,
        bodyParts: ['1', '1.text', '2', '2.text'],
      }, { uid: true });

      for await (const msg of messages) {
        result.checked += 1;
        try {
          const imported = await importMessage(msg, byEmail, byThread);
          if (imported) {
            result.imported += 1;
            if (imported.matched) result.matched += 1;
          } else {
            result.skipped += 1;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result.errors.push(message);
          logger.warn({ err, uid: msg.uid }, 'inbound email import failed');
          continue;
        }
        try {
          await client.messageFlagsAdd([msg.uid], ['\\Seen'], { uid: true });
        } catch {
          // Dedup is handled by provider_id; failing to mark seen just means
          // the next poll re-reads and skips it.
        }
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(message);
    logger.warn({ err }, 'inbound email sync failed');
  } finally {
    await client.logout().catch(() => {});
  }
  return result;
}

/**
 * Insert one parsed message into ipy_email_log. Idempotent on provider_id —
 * the unique index guards against a concurrent poll racing us. Returns null
 * when the message was already imported or had no usable sender, otherwise
 * whether it could be linked to a CRM record.
 */
async function importMessage(
  msg: FetchMessageObject,
  byEmail: Map<string, string>,
  byThread: Map<string, string>,
): Promise<{ matched: boolean } | null> {
  const env = msg.envelope;
  const sender = env?.from?.[0];
  if (!env || !sender?.address) {
    // No usable sender means nothing to match or display — drop it quietly.
    return null;
  }

  const messageId = (env.messageId ?? '').trim() || `imap:${msg.uid}`;
  const existing = await db.queryOne<{ id: string }>(
    `SELECT id FROM ipy_email_log WHERE provider_id = $1 LIMIT 1`,
    [messageId],
  );
  if (existing) return null;

  const senderAddress = sender.address.toLowerCase();
  const recipients = [...(env.to ?? []), ...(env.cc ?? [])]
    .map((r) => r.address)
    .filter((a): a is string => Boolean(a));

  const body = (part: string): string | null => msg.bodyParts?.get(part)?.toString() ?? null;
  const text = body('1.text') ?? body('2.text') ?? body('1');
  const html = body('1') ?? body('2');

  const recordId = byEmail.get(senderAddress) ?? matchByThread(env.inReplyTo, byThread) ?? null;

  await db.query(
    `INSERT INTO ipy_email_log
       (record_id, direction, from_address, to_addresses, cc_addresses,
        subject, body_html, body_text, status, provider_id, created_at)
     VALUES ($1,'inbound',$2,$3,$4,$5,$6,$7,'synced',$8,COALESCE($9, now()))
     ON CONFLICT (provider_id) DO NOTHING`,
    [
      recordId,
      sender.name ? `${sender.name} <${senderAddress}>` : senderAddress,
      JSON.stringify(recipients),
      JSON.stringify((env.cc ?? []).map((r) => r.address).filter(Boolean)),
      env.subject ?? null,
      html,
      text,
      messageId,
      env.date ? new Date(env.date) : null,
    ],
  );
  return { matched: Boolean(recordId) };
}

/**
 * Build sender-address -> record-id for every entity module that carries an
 * email-typed field. Party records (leads, organisations) are ranked first so
 * a person wins over a unit/project record that happens to share the address.
 *
 * One query per module (a plain row scan, no per-message binds), so a poll of
 * 25 messages costs a handful of lookups instead of one query per message.
 */
async function indexRecordsByEmail(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const modules = await registry.getModules({ activeOnly: true, entityOnly: true });
  const ranked = [...modules].sort((a, b) => rankModule(a.name) - rankModule(b.name));

  for (const mod of ranked) {
    const emailFields = mod.fields.filter((f) => f.uitype === 'email');
    if (!emailFields.length) continue;
    const table = quoteIdent(mod.tableName);
    const nonNull = emailFields.map((f) => `NULLIF(${fieldExpr(f, 't')}, '') IS NOT NULL`).join(' OR ');
    const res = await db.query<Record<string, unknown>>(
      `SELECT r.id::text,
              ${emailFields.map((f, i) => `lower(${fieldExpr(f, 't')}) AS addr_${i}`).join(', ')}
       FROM ipy_record r JOIN ${table} t ON t.record_id = r.id
       WHERE r.is_deleted = false AND (${nonNull})
       LIMIT 5000`,
    );
    for (const row of res.rows) {
      const id = row.id as string;
      for (let i = 0; i < emailFields.length; i++) {
        const addr = row[`addr_${i}`];
        if (typeof addr === 'string' && addr && !map.has(addr)) map.set(addr, id);
      }
    }
  }
  return map;
}

/** leads and organisations are the party records an inbound mail is about. */
function rankModule(name: string): number {
  if (name === 'leads') return 0;
  if (name === 'organisations') return 1;
  return 10;
}

/**
 * Fallback linking: a reply carrying an In-Reply-To header pointing at an
 * outbound message we've already logged gets attached to that message's
 * record instead of the sender (which may have changed address).
 */
async function indexOutboundThreads(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const rows = await db.query<{ provider_id: string; record_id: string | null }>(
    `SELECT provider_id, record_id FROM ipy_email_log
     WHERE direction = 'outbound' AND provider_id IS NOT NULL AND record_id IS NOT NULL
     LIMIT 2000`,
  );
  for (const r of rows.rows) if (r.record_id) map.set(r.provider_id, r.record_id);
  return map;
}

function matchByThread(inReplyTo: string | undefined, threads: Map<string, string>): string | null {
  if (!inReplyTo) return null;
  const id = inReplyTo.match(/<([^>]+)>/)?.[1] ?? inReplyTo.trim();
  return threads.get(id) ?? null;
}
