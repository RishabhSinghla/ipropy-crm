/**
 * Dealer groups, read live from the company's linked WhatsApp number (OpenWA).
 *
 * This replaces "export the chat, upload the file": a message written in a group arrives as a signed webhook,
 * waits a few seconds so a burst becomes one import, and then goes through `importGroupMessages` — the very
 * function an uploaded export goes through. So a deal read live and the same deal read later from a file are one
 * deal, never two.
 *
 * Privacy, in this order:
 *  1. A group is OFF until an admin switches it on. The number may sit in family or personal groups; those are
 *     recorded as a name in the list and nothing else — not one message from them is kept.
 *  2. Only written messages are used; photos, voice notes and stickers are dropped before this file sees them.
 *  3. Even in a switched-on group, the feed keeps only messages that read like a property deal or requirement
 *     (`looksLikeADeal`), exactly as for an uploaded export.
 */
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { afterImport, importGroupMessages } from './feed.js';
import { tidyBody, type ChatMessage } from './readPost.js';
import { OpenWaError, openWaGroupHistory, openWaGroups } from '../../integrations/whatsapp/business/openwa.js';
import type { GroupMessage } from '../../integrations/whatsapp/business/types.js';

export interface WaGroupRow {
  id: string;
  name: string;
  enabled: boolean;
  messagesSeen: number;
  lastMessageAt: string | null;
  historyState: 'none' | 'running' | 'done' | 'failed';
  historyAt: string | null;
  historyNote: string | null;
}

/** A burst of messages is imported together, this long after the last one. */
const FLUSH_AFTER_MS = 2_000;
const FLUSH_AT_COUNT = 50;

const waiting = new Map<string, { messages: ChatMessage[]; timer: NodeJS.Timeout | null }>();

/** The person the feed records as having brought these in: the first active admin. */
async function importer(): Promise<string | null> {
  const row = await db.queryOne<{ id: string }>(
    `SELECT id FROM ipy_user WHERE is_admin AND is_active ORDER BY created_at LIMIT 1`,
  );
  return row?.id ?? null;
}

function toRow(r: Record<string, unknown>): WaGroupRow {
  return {
    id: String(r.id),
    name: String(r.name ?? ''),
    enabled: Boolean(r.enabled),
    messagesSeen: Number(r.messages_seen ?? 0),
    lastMessageAt: r.last_message_at ? new Date(r.last_message_at as string).toISOString() : null,
    historyState: String(r.history_state ?? 'none') as WaGroupRow['historyState'],
    historyAt: r.history_at ? new Date(r.history_at as string).toISOString() : null,
    historyNote: (r.history_note as string | null) ?? null,
  };
}

export async function listWaGroups(): Promise<WaGroupRow[]> {
  const { rows } = await db.query(`SELECT * FROM ipy_wa_group ORDER BY enabled DESC, lower(name), id`);
  return rows.map(toRow);
}

/** Asks OpenWA for the group list and records any group not yet known (switched off) and any new name. */
export async function refreshGroupList(): Promise<{ total: number; added: number }> {
  const groups = await openWaGroups();
  let added = 0;
  for (const group of groups) {
    const result = await db.queryOne<{ inserted: boolean }>(
      `INSERT INTO ipy_wa_group (id, name, feed_name) VALUES ($1, $2, $2)
       ON CONFLICT (id) DO UPDATE SET
         name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE ipy_wa_group.name END,
         feed_name = CASE WHEN ipy_wa_group.feed_name <> '' THEN ipy_wa_group.feed_name ELSE EXCLUDED.name END
       RETURNING (xmax = 0) AS inserted`,
      [group.id, group.name],
    );
    if (result?.inserted) added += 1;
  }
  return { total: groups.length, added };
}

export async function setGroupEnabled(id: string, enabled: boolean): Promise<WaGroupRow | null> {
  const row = await db.queryOne<Record<string, unknown>>(`SELECT * FROM ipy_wa_group WHERE id = $1`, [id]);
  if (!row) return null;
  if (enabled && !String(row.feed_name ?? '').trim()) {
    // A group is filed in the feed under its name; with none, a later rename would split it into two groups.
    throw new Error('This group has no name yet. Refresh the list from WhatsApp first.');
  }
  const updated = await db.queryOne<Record<string, unknown>>(
    `UPDATE ipy_wa_group SET enabled = $2 WHERE id = $1 RETURNING *`, [id, enabled],
  );
  if (!enabled) dropWaiting(id);
  return updated ? toRow(updated) : null;
}

/** Switches on every named group at once. The admin has seen the list and pressed the button. */
export async function enableAllGroups(): Promise<number> {
  const result = await db.query(`UPDATE ipy_wa_group SET enabled = true WHERE NOT enabled AND name <> ''`);
  return result.rowCount ?? 0;
}

function dropWaiting(id: string): void {
  const entry = waiting.get(id);
  if (entry?.timer) clearTimeout(entry.timer);
  waiting.delete(id);
}

/** What the webhook hands over. Groups not switched on are noted in the list and otherwise forgotten at once. */
export async function noteGroupMessages(incoming: GroupMessage[]): Promise<void> {
  for (const message of incoming) {
    const known = await db.queryOne<{ name: string; enabled: boolean }>(
      `INSERT INTO ipy_wa_group (id, name, feed_name) VALUES ($1, $2, $2)
       ON CONFLICT (id) DO UPDATE SET
         name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE ipy_wa_group.name END,
         feed_name = CASE WHEN ipy_wa_group.feed_name <> '' THEN ipy_wa_group.feed_name ELSE EXCLUDED.name END
       RETURNING feed_name AS name, enabled`,
      [message.groupId, message.groupName ?? ''],
    );
    if (!known?.enabled || !known.name.trim()) continue;

    await db.query(
      `UPDATE ipy_wa_group SET messages_seen = messages_seen + 1,
              last_message_at = GREATEST(coalesce(last_message_at, $2::timestamptz), $2::timestamptz) WHERE id = $1`,
      [message.groupId, message.sentAt.toISOString()],
    );
    queue(message.groupId, { postedAt: message.sentAt, sender: message.sender, body: tidyBody(message.text) });
  }
}

function queue(groupId: string, message: ChatMessage): void {
  const entry = waiting.get(groupId) ?? { messages: [], timer: null };
  entry.messages.push(message);
  waiting.set(groupId, entry);
  if (entry.timer) clearTimeout(entry.timer);
  if (entry.messages.length >= FLUSH_AT_COUNT) { void flush(groupId); return; }
  entry.timer = setTimeout(() => { void flush(groupId); }, FLUSH_AFTER_MS);
  entry.timer.unref?.();
}

/** Exported so a test (and a clean shutdown) can finish the wait instead of sleeping through it. */
export async function flush(groupId: string): Promise<void> {
  const entry = waiting.get(groupId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  waiting.delete(groupId);
  if (!entry.messages.length) return;
  try {
    const group = await db.queryOne<{ name: string; enabled: boolean }>(`SELECT feed_name AS name, enabled FROM ipy_wa_group WHERE id = $1`, [groupId]);
    const userId = await importer();
    // Switched off while the messages waited: they go nowhere.
    if (!group?.enabled || !userId) return;
    // ignoreMark: the "read up to" mark belongs to file exports. A live message that arrives after a newer one
    // must still be kept; the fingerprints already stop any repeat.
    const outcome = await importGroupMessages(group.name, entry.messages, userId, { ignoreMark: true });
    if (outcome.newDeals) void afterImport(group.name);
    logger.info({ group: group.name, ...outcome }, 'dealer groups: live messages imported');
  } catch (err) {
    // One failed import must not take the webhook down; the same messages are still safe to read from a later history run.
    logger.error({ err, groupId }, 'dealer groups: could not import live messages');
  }
}

// ---------------------------------------------------------------------------
// History: read what a group said before the live feed was switched on
// ---------------------------------------------------------------------------

export interface HistoryJob { running: boolean; done: number; total: number; current: string | null; startedAt: string | null }
const job: HistoryJob = { running: false, done: 0, total: 0, current: null, startedAt: null };
export function historyJobStatus(): HistoryJob { return { ...job }; }

/**
 * Can this OpenWA read a group's old messages? The Baileys engine cannot (WhatsApp does not hand a linked device
 * its old chats on request; OpenWA answers HTTP 501), the Chromium engine can. Asked once with a one-message read
 * and remembered for ten minutes. `null` means "could not tell", which is treated as "maybe": the button stays.
 */
let supportCache: { at: number; supported: boolean | null } | null = null;
export async function historySupported(): Promise<boolean | null> {
  if (supportCache && Date.now() - supportCache.at < 10 * 60_000) return supportCache.supported;
  const any = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_wa_group ORDER BY enabled DESC, id LIMIT 1`);
  let supported: boolean | null = null;
  if (any) {
    try {
      await openWaGroupHistory(any.id, 1);
      supported = true;
    } catch (err) {
      supported = err instanceof OpenWaError && err.status === 501 ? false : null;
    }
    supportCache = { at: Date.now(), supported };
  }
  return supported;
}
export function forgetHistorySupport(): void { supportCache = null; }

/** A pause between groups, long and uneven on purpose: this is reading from the company's own number. */
export const PAUSE_BETWEEN_GROUPS_MS = { min: 4_000, max: 9_000 };

async function oneGroupHistory(id: string): Promise<void> {
  const group = await db.queryOne<{ name: string; enabled: boolean }>(`SELECT feed_name AS name, enabled FROM ipy_wa_group WHERE id = $1`, [id]);
  if (!group?.enabled) return;
  await db.query(`UPDATE ipy_wa_group SET history_state = 'running', history_note = NULL WHERE id = $1`, [id]);
  try {
    const userId = await importer();
    if (!userId) throw new Error('There is no active admin to record the import against.');
    const lines = await openWaGroupHistory(id, 2000, true);
    const messages = lines.map((line) => ({ postedAt: line.sentAt, sender: line.sender, body: tidyBody(line.text) }));
    // The admin may have switched the group off while OpenWA was still fetching: that opt-out wins.
    const still = await db.queryOne<{ enabled: boolean }>(`SELECT enabled FROM ipy_wa_group WHERE id = $1`, [id]);
    if (!still?.enabled) {
      await db.query(`UPDATE ipy_wa_group SET history_state = 'none', history_note = 'Switched off before the import; nothing was kept.' WHERE id = $1`, [id]);
      return;
    }
    // ignoreMark: live messages may already have moved the "read up to" mark past older history.
    const outcome = await importGroupMessages(group.name, messages, userId, { ignoreMark: true });
    await afterImport(group.name);
    // A message the database refused is not "done": leave the group retryable and say how many.
    const state = outcome.refused > 0 ? 'failed' : 'done';
    const note = outcome.refused > 0
      ? `${outcome.refused} messages could not be saved. Press "Read again" to retry.`
      : `${outcome.messages} messages read, ${outcome.newDeals} new deals`;
    await db.query(
      `UPDATE ipy_wa_group SET history_state = $3, history_at = now(), history_note = $2 WHERE id = $1`,
      [id, note, state],
    );
  } catch (err) {
    await db.query(
      `UPDATE ipy_wa_group SET history_state = 'failed', history_at = now(), history_note = $2 WHERE id = $1`,
      [id, (err as Error).message.slice(0, 300)],
    );
    logger.warn({ err, group: group.name }, 'dealer groups: history import failed');
  }
}

/**
 * Reads the history of every switched-on group that has not been read yet (or failed), one at a time with a
 * random pause between them. It is safe to press again: a finished group is skipped, so it resumes where it stopped.
 * Returns at once; progress is `historyJobStatus()` and each group's own state in the list.
 */
export const NO_HISTORY_REASON =
  'This WhatsApp connection cannot fetch old messages (WhatsApp does not hand them to a linked device). New messages arrive live. '
  + 'To bring in older ones, export the chat from your phone and drop the file on Dealer Groups.';

export async function startHistoryImport(only?: string): Promise<{ started: boolean; reason?: string }> {
  if (await historySupported() === false) return { started: false, reason: NO_HISTORY_REASON };
  if (job.running) return { started: false, reason: 'A history import is already running.' };
  job.running = true;
  job.startedAt = new Date().toISOString();
  void (async () => {
    try {
      const { rows } = await db.query<{ id: string }>(
        only
          ? `SELECT id FROM ipy_wa_group WHERE id = $1 AND enabled`
          : `SELECT id FROM ipy_wa_group WHERE enabled AND history_state <> 'done' ORDER BY lower(name)`,
        only ? [only] : [],
      );
      job.total = rows.length;
      job.done = 0;
      for (const row of rows) {
        job.current = row.id;
        await oneGroupHistory(row.id);
        job.done += 1;
        if (job.done < job.total) {
          const { min, max } = PAUSE_BETWEEN_GROUPS_MS;
          await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));
        }
      }
    } catch (err) {
      logger.error({ err }, 'dealer groups: history import stopped');
    } finally {
      job.running = false;
      job.current = null;
    }
  })();
  return { started: true };
}
