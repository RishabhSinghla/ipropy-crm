/**
 * "Chase this person on <date>."
 *
 * This used to be an Activity record — a whole module whose only real job was
 * to hold a subject, an owner and a due date against a lead. The lead already
 * carries the due date (`next_followup_at`) and the owner, so with Activities
 * removed the same intent is expressed with what is already there:
 *
 *   * the date lands on the record, where the Follow-ups views read it;
 *   * the reason lands in the timeline as a note, so it is still legible six
 *     weeks later — an activity's subject was the only place that lived;
 *   * the owner gets a notification, which is what actually made anyone act.
 *
 * Every caller that used to create an activity (a workflow action, call
 * analysis, a WhatsApp sequence, a logged call's callback) goes through here,
 * so there is one definition of what scheduling a follow-up means.
 */
import { db, type Tx } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { registry } from '../metadata/registry.js';
import { notify } from '../notifications/index.js';

export interface FollowUpInput {
  recordId: string;
  module: string;
  /** The day to chase on. A time component is discarded — follow-ups are dates. */
  on: Date | string;
  /** Shown in the notification and written to the timeline. */
  reason: string;
  /** Extra context for the note. */
  notes?: string | null;
  /** Who should act. Defaults to the record's owner. */
  ownerId?: string | null;
  /** Attributed author of the timeline note. */
  authorId?: string | null;
  /** Only bring the date forward, never push it back. */
  onlyIfSooner?: boolean;
}

function asDate(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime())
    ? new Date().toISOString().slice(0, 10)
    : d.toISOString().slice(0, 10);
}

export async function scheduleFollowUp(input: FollowUpInput, conn: Tx = db): Promise<void> {
  const due = asDate(input.on);

  try {
    const module = await registry.getModule(input.module);
    const field = module?.fields.find((f) => f.name === 'next_followup_at');

    // Only modules that actually track a follow-up date get one written; the
    // note and the notification are worth doing either way.
    if (field?.storage === 'column') {
      await conn.query(
        `UPDATE ${module!.tableName} SET next_followup_at = $2
         WHERE record_id = $1 AND ($3 = false OR next_followup_at IS NULL OR next_followup_at > $2::date)`,
        [input.recordId, due, input.onlyIfSooner ?? false],
      );
    }

    const owner = await conn.queryOne<{ owner_id: string | null; label: string }>(
      `SELECT owner_id, label FROM ipy_record WHERE id = $1`, [input.recordId],
    );

    const author = input.authorId ?? owner?.owner_id ?? null;
    if (author) {
      await conn.query(
        `INSERT INTO ipy_comment (record_id, user_id, body) VALUES ($1,$2,$3)`,
        [input.recordId, author, [input.reason, input.notes].filter(Boolean).join('\n\n')],
      );
    }

    const recipient = input.ownerId ?? owner?.owner_id;
    if (recipient) {
      await notify({
        userId: recipient,
        kind: 'reminder',
        title: `Follow up: ${owner?.label ?? 'a record'}`,
        body: `${input.reason} — due ${due}`,
        link: `/${input.module}/${input.recordId}`,
        recordId: input.recordId,
      }, conn);
    }
  } catch (err) {
    // A follow-up is a nicety attached to something that already succeeded (a
    // call was logged, a message was sent). Never fail the caller over it.
    logger.warn({ err, recordId: input.recordId }, 'could not schedule follow-up');
  }
}
