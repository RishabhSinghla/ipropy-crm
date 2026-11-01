/**
 * Fetching customer messages a number missed while the CRM could not hear it.
 *
 * Why this exists: the CRM's webhook answers OpenWA with "200 received" before it stores the message (a slow store would
 * make OpenWA resend). So a CRM restart or crash in that instant, or a number that was offline, can leave a customer
 * message that OpenWA has and the CRM does not. OpenWA keeps its own copy of every message, so after a number comes back
 * (and once after the CRM starts) the CRM asks for what arrived since it last looked and feeds it through the very same
 * door a live webhook uses — `receiveInbound`, whose unique-id claim makes a message that is already here a harmless no-op.
 *
 * Only customer messages (incoming) are fetched. Groups, channels and status posts are skipped by the same parser.
 */
import { db } from '../../../db/pool.js';
import { logger } from '../../../utils/logger.js';
import { OPENWA_PROVIDER, openWaManage, parseOpenWaWebhook } from './openwa.js';
import { receiveInbound } from './inbound.js';

const MAX_LOOKBACK_MS = 48 * 3_600_000;
const PAGE = 100;
const MAX_PAGES = 20;

/** OpenWA's stored message, reshaped into what a live `message.received` delivery carries. Pure. */
export function storedToWebhookData(row: Record<string, unknown>): Record<string, unknown> {
  const chatId = String(row.chatId ?? '');
  const ts = Number(row.timestamp);
  return {
    id: row.waMessageId ?? row.id,
    from: row.from, to: row.to, chatId,
    body: row.body, type: row.type,
    // OpenWA stores seconds; be forgiving if a build stores milliseconds.
    timestamp: ts > 1e12 ? Math.floor(ts / 1000) : ts,
    isGroup: /@g\.us$/.test(chatId),
    kind: /@(g\.us|broadcast|newsletter)$/.test(chatId) || chatId === 'status@broadcast' ? 'other' : 'individual',
    fromMe: false,
    contact: (row.metadata as { contact?: unknown } | undefined)?.contact,
    media: (row.metadata as { media?: unknown } | undefined)?.media,
  };
}

export function lookbackStart(lastCatchUp: Date | null, now: Date, fallbackMs: number): Date {
  const earliest = now.getTime() - MAX_LOOKBACK_MS;
  const wanted = lastCatchUp ? lastCatchUp.getTime() - 5 * 60_000 : now.getTime() - fallbackMs;
  return new Date(Math.max(earliest, wanted));
}

export interface CatchUpResult { fetched: number; stored: number; alreadyHad: number; skipped: number; since: string }

/** `dryRun` fetches and parses but writes nothing, so the first run on a real number can be looked at before it is trusted. */
export async function catchUpNumber(numberId: string, opts: { dryRun?: boolean; fallbackMs?: number } = {}): Promise<CatchUpResult> {
  const n = await db.queryOne<{ id: string; session_id: string | null; last_catchup_at: Date | null }>(
    `SELECT id, session_id, last_catchup_at FROM ipy_wa_number WHERE id = $1`, [numberId]);
  if (!n?.session_id) throw new Error('This number is not known to OpenWA yet.');
  const since = lookbackStart(n.last_catchup_at, new Date(), opts.fallbackMs ?? 3_600_000);
  const started = new Date();
  const result: CatchUpResult = { fetched: 0, stored: 0, alreadyHad: 0, skipped: 0, since: since.toISOString() };

  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({
      direction: 'incoming', since: String(since.getTime()), limit: String(PAGE), orderBy: 'timestamp', inlineMedia: 'false',
    });
    if (after) qs.set('after', after);
    const out = await openWaManage<{ messages?: Record<string, unknown>[]; data?: Record<string, unknown>[] } | Record<string, unknown>[]>(
      `/api/sessions/${n.session_id}/messages?${qs.toString()}`);
    const rows = Array.isArray(out) ? out : (out.messages ?? out.data ?? []);
    if (!rows.length) break;
    for (const row of rows) {
      result.fetched += 1;
      const batch = parseOpenWaWebhook({ event: 'message.received', sessionId: n.session_id, data: storedToWebhookData(row) });
      if (!batch.messages.length) { result.skipped += 1; continue; }
      if (opts.dryRun) { result.stored += 1; continue; }
      for (const message of batch.messages) {
        const stored = await receiveInbound(OPENWA_PROVIDER, message, n.id);
        if (stored) result.stored += 1; else result.alreadyHad += 1;
      }
    }
    const last = rows[rows.length - 1];
    after = typeof last.id === 'string' ? last.id : null;
    if (rows.length < PAGE || !after) break;
  }
  if (!opts.dryRun) {
    await db.query(`UPDATE ipy_wa_number SET last_catchup_at = $2 WHERE id = $1`, [n.id, started]);
    if (result.stored) logger.warn({ number: n.id, ...result }, 'whatsapp catch-up stored messages the webhook had missed');
  }
  return result;
}
