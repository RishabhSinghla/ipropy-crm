/**
 * Files dropped on the Dealer groups page, read one after another in the background.
 *
 * An export of a busy group is a few megabytes and tens of thousands of lines;
 * reading it takes minutes, not the seconds a web request is allowed. So a drop
 * answers at once with a row per chat, and the reading happens here while the page
 * watches the rows change from queued to done.
 *
 * Three things keep it cheap and safe to do again:
 *  - the **same file** dropped twice is recognised by its hash and does nothing;
 *  - the **same group** dropped again is read only from where the last drop ended
 *    (`importGroupExport` keeps that mark);
 *  - a restart mid-way loses nothing: the rows say what happened, and dropping the file
 *    again carries on from where it stopped.
 */
import { createHash } from 'node:crypto';
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { afterImport, groupKey, importGroupExport } from './feed.js';
import { chatsFromZip, groupFromFileName, looksLikeAZip } from './unzipChat.js';

export interface ImportRow {
  id: string;
  groupName: string;
  fileName: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'duplicate';
  messages: number;
  deals: number;
  newDeals: number;
  repeats: number;
  skippedOld: number;
  listings: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

interface Waiting { id: string; groupName: string; text: string; userId: string }

/** The text waits in memory, not in the database: it is somebody's chat and is not kept once read. */
const waiting: Waiting[] = [];
let draining = false;

const COLUMNS = `id, group_name, file_name, status, messages, deals, new_deals, repeats, skipped_old, listings, error, created_at, finished_at`;

function toRow(row: Record<string, unknown>): ImportRow {
  return {
    id: row.id as string,
    groupName: row.group_name as string,
    fileName: row.file_name as string,
    status: row.status as ImportRow['status'],
    messages: row.messages as number,
    deals: row.deals as number,
    newDeals: row.new_deals as number,
    repeats: row.repeats as number,
    skippedOld: row.skipped_old as number,
    listings: row.listings as number,
    error: row.error as string | null,
    createdAt: new Date(row.created_at as string).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at as string).toISOString() : null,
  };
}

async function newRow(groupName: string, fileName: string, hash: string, status: ImportRow['status'], error: string | null, userId: string): Promise<ImportRow> {
  const row = await db.queryOne<Record<string, unknown>>(
    `INSERT INTO ipy_market_import (group_name, file_name, file_hash, status, error, created_by, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $4 IN ('duplicate', 'failed') THEN now() END)
     RETURNING ${COLUMNS}`,
    [groupName, fileName, hash, status, error, userId],
  );
  return toRow(row!);
}

/**
 * Take the dropped files in. A zip may hold several chats; a plain .txt is one.
 * `groupOverride` names the group only when the drop turns out to be a single chat — with
 * several, each is named from its own file, because one name for ten groups is wrong for nine.
 */
export async function queueImports(
  files: Array<{ name: string; buffer: Buffer }>, groupOverride: string | null, userId: string,
): Promise<ImportRow[]> {
  const chats: Array<{ fileName: string; path: string; text: string }> = [];
  const failures: ImportRow[] = [];
  for (const file of files) {
    try {
      if (looksLikeAZip(file.buffer)) {
        for (const chat of await chatsFromZip(file.buffer)) chats.push({ fileName: file.name, path: chat.path, text: chat.text });
      } else {
        chats.push({ fileName: file.name, path: file.name, text: file.buffer.toString('utf8') });
      }
    } catch (err) {
      failures.push(await newRow(groupFromFileName(file.name), file.name, '-', 'failed', err instanceof Error ? err.message : 'Could not read that file', userId));
    }
  }

  const rows: ImportRow[] = [...failures];
  for (const chat of chats) {
    const groupName = groupKey(chats.length === 1 && groupOverride ? groupOverride : groupFromFileName(chat.path, chat.fileName));
    const hash = createHash('sha256').update(chat.text).digest('hex');
    if (!chat.text.trim()) {
      rows.push(await newRow(groupName, chat.fileName, hash, 'failed', 'That file has no messages in it.', userId));
      continue;
    }
    const seen = await db.queryOne<{ id: string }>(
      `SELECT id FROM ipy_market_import WHERE file_hash = $1 AND group_name = $2 AND status = 'done' LIMIT 1`, [hash, groupName],
    );
    if (seen) {
      rows.push(await newRow(groupName, chat.fileName, hash, 'duplicate', 'Already read — this exact file was dropped before.', userId));
      continue;
    }
    const row = await newRow(groupName, chat.fileName, hash, 'queued', null, userId);
    waiting.push({ id: row.id, groupName, text: chat.text, userId });
    rows.push(row);
  }
  void drain();
  return rows;
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (let next = waiting.shift(); next; next = waiting.shift()) {
      await db.query(`UPDATE ipy_market_import SET status = 'running' WHERE id = $1`, [next.id]);
      try {
        const outcome = await importGroupExport(next.groupName, next.text, next.userId);
        await db.query(
          `UPDATE ipy_market_import SET status = 'done', messages = $2, deals = $3, new_deals = $4, repeats = $5, skipped_old = $6, listings = $7, finished_at = now() WHERE id = $1`,
          [next.id, outcome.messages, outcome.deals, outcome.newDeals, outcome.repeats, outcome.skippedOld, outcome.listings],
        );
        await afterImport(next.groupName);
      } catch (err) {
        logger.warn({ err, group: next.groupName }, 'market: reading a group failed');
        await db.query(`UPDATE ipy_market_import SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
          [next.id, err instanceof Error ? err.message.slice(0, 300) : 'Reading failed']);
      }
    }
  } finally {
    draining = false;
  }
}

export async function listImports(limit = 40): Promise<ImportRow[]> {
  const rows = await db.query<Record<string, unknown>>(`SELECT ${COLUMNS} FROM ipy_market_import ORDER BY created_at DESC LIMIT $1`, [limit]);
  return rows.rows.map(toRow);
}

/** A restart loses the waiting text; say so on the row rather than leaving one that looks alive. */
export async function recoverInterruptedImports(): Promise<void> {
  await db.query(
    `UPDATE ipy_market_import SET status = 'failed', finished_at = now(),
            error = 'The server restarted while this was being read. Drop the file again — it carries on from where it stopped.'
      WHERE status IN ('queued', 'running')`,
  );
}
