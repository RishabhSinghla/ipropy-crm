/**
 * The same person, entered twice, spelled differently.
 *
 * Rajesh Kumar enquires on 99acres in March. In July he messages from a
 * different number and somebody types him in as "R. Kumar". Two records, two
 * reps chasing one man, and he concludes you are disorganised.
 *
 * Exact matching cannot see it: the names share almost no letters and the
 * numbers differ. Meaning can, because it looks at the whole shape of the
 * record — similar name, same locality, same budget, same configuration, same
 * kind of enquiry.
 *
 * **It only ever suggests.** Nothing merges on its own, and it should not:
 * fathers and sons share a surname, a locality and a budget, and a CRM that
 * quietly welded two buyers together would be worse than one that missed them.
 * The suggestion sits on the record with Merge and Not the same beside it, and
 * dismissing one is remembered so it never asks again.
 */
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { featureOn } from '../settings/aiFeatures.js';
import { search } from './semantic.js';
import type { ServiceContext } from '../entity/recordService.js';

export interface DuplicateSuggestion {
  recordId: string;
  label: string;
  /** 0 to 1. Only the confident ones are ever shown. */
  confidence: number;
  why: string;
}

/**
 * Below this it is a coincidence, not a person.
 *
 * Tuned to be quiet rather than thorough. A false suggestion costs somebody
 * thirty seconds and a little trust in the feature; a missed one costs nothing
 * they did not already have.
 */
const FLOOR = 0.62;

export async function suggestDuplicates(
  ctx: ServiceContext,
  moduleName: string,
  recordId: string,
): Promise<DuplicateSuggestion[]> {
  if (!await featureOn('duplicateSuggestions')) return [];

  const subject = await db.queryOne<{ label: string; search_text: string | null }>(
    `SELECT label, search_text FROM ipy_record WHERE id = $1 AND is_deleted = false`,
    [recordId],
  );
  if (!subject) return [];

  const question = `${subject.label}. ${subject.search_text ?? ''}`.trim();
  if (question.length < 8) return [];

  const hits = await search(question, ctx, { modules: [moduleName], top: 6, candidates: 40 })
    .catch((err) => {
      logger.debug({ err, recordId }, 'duplicate search failed');
      return [];
    });

  const others = hits.filter((h) => h.recordId !== recordId && h.score >= FLOOR);
  if (!others.length) return [];

  const dismissed = await db.query<{ other_id: string }>(
    `SELECT other_id FROM ipy_duplicate_dismissal
      WHERE record_id = $1 OR other_id = $1`,
    [recordId],
  );
  const ignored = new Set(dismissed.rows.map((r) => r.other_id));

  return others
    .filter((h) => !ignored.has(h.recordId))
    .slice(0, 3)
    .map((h) => ({
      recordId: h.recordId,
      label: h.label,
      confidence: Math.min(1, h.score),
      // What matched, in the words that matched, so somebody can judge it in a
      // glance rather than trusting a percentage.
      why: h.passages[0]?.content.slice(0, 180) ?? '',
    }));
}

/** Remember a "not the same", so the same pair is never offered again. */
export async function dismissDuplicate(
  recordId: string,
  otherId: string,
  userId: string | null,
): Promise<void> {
  // Stored both ways round. Whichever record somebody happened to be looking at
  // when they said no, the answer holds for the pair.
  // Three parameters, three referenced. Postgres refuses a statement with a
  // bound parameter it never reads, and this codebase has been bitten by that
  // three times — see CLAUDE.md rule 8.
  await db.query(
    `INSERT INTO ipy_duplicate_dismissal (record_id, other_id, dismissed_by)
     VALUES ($1,$2,$3), ($2,$1,$3)
     ON CONFLICT (record_id, other_id) DO NOTHING`,
    [recordId, otherId, userId],
  );
}
