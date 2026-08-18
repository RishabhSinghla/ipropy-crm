/**
 * What "Hot" means, and the other four numbers like it.
 *
 * These are business judgements, not constants: a sales head who has watched a
 * quarter of pipeline will want Hot to mean 75, and that should not need a
 * developer or a release. They lived as literals in three server files with two
 * of them written a fourth time in the web kanban badge, which is the shape
 * this codebase keeps getting bitten by — see the country-code picklist.
 *
 * Cached because lead scoring runs on every record change and a database round
 * trip per score is a real cost. `invalidateScoring()` is called when settings
 * are saved, so an edit takes effect on the next score rather than the next
 * restart.
 */
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';

export interface ScoringThresholds {
  hotAt: number;
  warmAt: number;
  gradeAAt: number;
  gradeBAt: number;
  gradeCAt: number;
  matchFloor: number;
}

/** What the code did before any of this was editable. */
const FALLBACK: ScoringThresholds = {
  hotAt: 70, warmAt: 45, gradeAAt: 80, gradeBAt: 60, gradeCAt: 40, matchFloor: 55,
};

const KEYS: Record<keyof ScoringThresholds, string> = {
  hotAt: 'scoring.hot_at',
  warmAt: 'scoring.warm_at',
  gradeAAt: 'scoring.grade_a_at',
  gradeBAt: 'scoring.grade_b_at',
  gradeCAt: 'scoring.grade_c_at',
  matchFloor: 'scoring.match_floor',
};

let cached: ScoringThresholds | null = null;

export function invalidateScoring(): void {
  cached = null;
}

/**
 * Read as a number, clamped to 0-100, falling back per key rather than
 * wholesale. A single nonsensical value should cost that one number, not send
 * every threshold back to the default and change scoring in ways nobody asked
 * for.
 */
function toScore(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) return fallback;
  return Math.round(n);
}

export async function scoringThresholds(): Promise<ScoringThresholds> {
  if (cached) return cached;

  try {
    const rows = await db.query<{ key: string; value: unknown }>(
      `SELECT key, value FROM ipy_setting WHERE key = ANY($1)`,
      [Object.values(KEYS)],
    );
    const map = new Map(rows.rows.map((r) => [r.key, r.value]));
    const read = (k: keyof ScoringThresholds): number => toScore(map.get(KEYS[k]), FALLBACK[k]);

    const next: ScoringThresholds = {
      hotAt: read('hotAt'),
      warmAt: read('warmAt'),
      gradeAAt: read('gradeAAt'),
      gradeBAt: read('gradeBAt'),
      gradeCAt: read('gradeCAt'),
      matchFloor: read('matchFloor'),
    };

    // Warm above Hot would make every warm lead hot and nothing warm, which
    // looks like scoring being broken rather than a setting being wrong. The
    // same for grades. Order is enforced here so one careless edit cannot make
    // the pipeline nonsense; the admin screen also refuses it, but this is the
    // side that has to hold.
    if (next.warmAt > next.hotAt) next.warmAt = next.hotAt;
    if (next.gradeBAt > next.gradeAAt) next.gradeBAt = next.gradeAAt;
    if (next.gradeCAt > next.gradeBAt) next.gradeCAt = next.gradeBAt;

    cached = next;
    return next;
  } catch (err) {
    // Scoring must never fail because a setting could not be read.
    logger.warn({ err }, 'could not read scoring thresholds, using defaults');
    return FALLBACK;
  }
}

/** The one place a score becomes a word. */
export function temperatureFor(score: number, t: ScoringThresholds): 'Hot' | 'Warm' | 'Cold' {
  return score >= t.hotAt ? 'Hot' : score >= t.warmAt ? 'Warm' : 'Cold';
}

/** The one place a score becomes a letter. */
export function gradeFor(score: number, t: ScoringThresholds): 'A' | 'B' | 'C' | 'D' {
  if (score >= t.gradeAAt) return 'A';
  if (score >= t.gradeBAt) return 'B';
  if (score >= t.gradeCAt) return 'C';
  return 'D';
}

// ---------------------------------------------------------------------------
// Which properties the public website shows
// ---------------------------------------------------------------------------

/** What the code did before this was a setting. */
const FALLBACK_PUBLIC_STATUSES = ['Available'];

let cachedStatuses: string[] | null = null;

export function invalidatePublicStatuses(): void {
  cachedStatuses = null;
}

/**
 * Read as a list of non-empty strings.
 *
 * An empty list is refused rather than honoured. Saving one would be read as
 * "show nothing", and an empty public website looks like an outage rather than
 * a setting — nobody would connect a blank site to a checkbox they cleared an
 * hour ago. So an empty value falls back to the default and the site keeps
 * working while somebody notices.
 */
export async function publicPropertyStatuses(): Promise<string[]> {
  if (cachedStatuses) return cachedStatuses;
  try {
    const row = await db.queryOne<{ value: unknown }>(
      `SELECT value FROM ipy_setting WHERE key = 'website.public_statuses'`,
    );
    const raw = row?.value;
    const list = (Array.isArray(raw) ? raw : [])
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter(Boolean);
    cachedStatuses = list.length ? list : FALLBACK_PUBLIC_STATUSES;
    return cachedStatuses;
  } catch (err) {
    logger.warn({ err }, 'could not read the public property statuses, using the default');
    return FALLBACK_PUBLIC_STATUSES;
  }
}
