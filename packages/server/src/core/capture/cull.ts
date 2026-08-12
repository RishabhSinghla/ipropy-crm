/** Non-destructive, conservative photo culling for property galleries. */
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { getDriver } from '../storage/index.js';
import { analyse, cull, type Candidate } from './imageStats.js';

const BATCH = 5;

interface PhotoRow {
  id: string;
  phash: string | null;
  stats: { sharpness?: number; brightness?: number } | null;
  storage_key: string;
  variants: Record<string, string> | null;
}

async function ensureStats(row: PhotoRow): Promise<Candidate | null> {
  if (row.phash && typeof row.stats?.sharpness === 'number') {
    return {
      id: row.id,
      phash: row.phash,
      sharpness: row.stats.sharpness,
      brightness: row.stats.brightness ?? 128,
    };
  }

  const driver = await getDriver();
  const key = row.variants?.medium ?? row.variants?.large ?? row.storage_key;
  const buffer = await driver.read(key);
  if (!buffer) throw new Error('Photo is missing from storage');
  const stats = await analyse(buffer);
  await db.query(
    `UPDATE ipy_attachment SET phash = $2, stats = $3::jsonb WHERE id = $1`,
    [row.id, stats.phash, JSON.stringify(stats)],
  );
  return { id: row.id, phash: stats.phash, sharpness: stats.sharpness, brightness: stats.brightness };
}

export interface CullSummary {
  recordId: string;
  total: number;
  kept: number;
  dropped: Record<string, number>;
}

export async function cullRecord(recordId: string): Promise<CullSummary | null> {
  const { rows } = await db.query<PhotoRow>(
    `SELECT id, phash, stats, storage_key, variants
       FROM ipy_attachment
      WHERE record_id = $1 AND mime_type LIKE 'image/%'
      ORDER BY captured_at NULLS LAST, created_at`,
    [recordId],
  );
  if (!rows.length) return null;

  const candidates: Candidate[] = [];
  for (const row of rows) {
    try {
      const candidate = await ensureStats(row);
      if (candidate) candidates.push(candidate);
    } catch (err) {
      // Uncertain means keep. Leaving NULL would retry an unreadable file every
      // minute forever; hiding it would let a decoder failure masquerade as a
      // quality judgement. The Files tab and recommended gallery both retain it.
      await db.query(
        `UPDATE ipy_attachment
            SET cull_state = 'keep',
                stats = COALESCE(stats, '{}'::jsonb) || $2::jsonb
          WHERE id = $1`,
        [row.id, JSON.stringify({ analysisError: err instanceof Error ? err.message : String(err) })],
      );
      logger.warn({ err, attachmentId: row.id }, 'cull: could not measure photo; keeping it');
    }
  }
  if (!candidates.length) return null;

  const verdicts = cull(candidates);
  const dropped: Record<string, number> = {};
  for (const verdict of verdicts) {
    const state = verdict.keep ? 'keep' : verdict.reason ?? 'keep';
    if (!verdict.keep) dropped[state] = (dropped[state] ?? 0) + 1;
    await db.query(
      `UPDATE ipy_attachment SET cull_state = $2, cull_of = $3 WHERE id = $1`,
      [verdict.id, state, verdict.duplicateOf],
    );
  }

  return {
    recordId,
    total: verdicts.length,
    kept: verdicts.filter((verdict) => verdict.keep).length,
    dropped,
  };
}

export async function cullPendingRecords(limit = BATCH): Promise<CullSummary[]> {
  const { rows } = await db.query<{ record_id: string }>(
    `SELECT DISTINCT a.record_id
       FROM ipy_attachment a
       JOIN ipy_record r ON r.id = a.record_id
      WHERE a.record_id IS NOT NULL
        AND a.cull_state IS NULL
        AND a.mime_type LIKE 'image/%'
        AND r.module_name = 'properties'
        AND r.is_deleted = false
      LIMIT $1`,
    [limit],
  );

  const summaries: CullSummary[] = [];
  for (const row of rows) {
    try {
      const summary = await cullRecord(row.record_id);
      if (summary) summaries.push(summary);
    } catch (err) {
      logger.error({ err, recordId: row.record_id }, 'cull: property pass failed');
    }
  }
  if (summaries.length) {
    logger.info({
      properties: summaries.length,
      total: summaries.reduce((sum, item) => sum + item.total, 0),
      kept: summaries.reduce((sum, item) => sum + item.kept, 0),
    }, 'cull: conservatively judged property photos');
  }
  return summaries;
}
