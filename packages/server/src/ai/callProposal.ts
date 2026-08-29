/**
 * What the CRM asks you after a call, instead of waiting to be told.
 *
 * This is the fix for the way every CRM dies. A rep finishes a call in a car,
 * agrees a site visit for Saturday, and the record still says "New" three weeks
 * later — not because they are lazy but because updating it costs opening the
 * app, finding the lead, changing two fields and typing a note, and the next
 * call is already ringing. So the data rots, and everything built on top of it
 * — the scoring, the matching, the follow-up list — is reasoning about a
 * business that no longer exists.
 *
 * The analysis already reads the transcript. All that was missing was for it to
 * *ask*: "Riya agreed to visit on Saturday. Move her to Site Visit Scheduled
 * and chase on the 16th?" One tap, from the notification, in the car.
 *
 * **Proposed, never applied.** The existing extraction writes a stated budget
 * into an empty field on its own, and that is fine — it is transcribing
 * something the buyer said. A pipeline status is a judgement, and a wrong one
 * is worse than a stale one: it drops the lead out of the follow-up list and
 * into a stage nobody is working. So this goes through the same confirm flow
 * Ask iPropy uses, which re-checks permission at the moment of confirmation and
 * writes through `updateRecord` like any other edit.
 */
import { db } from '../db/pool.js';
import { logger } from '../utils/logger.js';
import { registry } from '../core/metadata/registry.js';
import { notify } from '../core/notifications/index.js';
import type { CallAnalysis } from './callAnalysis.js';

/**
 * How long a rep has to answer.
 *
 * A chat proposal expires in 30 minutes because you are looking at the screen.
 * This one arrives while somebody is driving between site visits, so it has to
 * survive the drive, the next call and getting back to a desk. Two days is
 * generous and still short enough that a stale proposal never surprises anyone
 * — by then the call is not fresh in mind and re-reading it is the honest move.
 */
const PROPOSAL_TTL_HOURS = 48;

export interface CallProposalInput {
  callId: string;
  recordId: string;
  module: string;
  /** Who made the call, and therefore who is asked to confirm. */
  userId: string | null;
  analysis: CallAnalysis;
}

/**
 * Build the proposal, store it, and put it on the rep's phone.
 *
 * Returns the proposal id, or null when the call implied no change worth
 * asking about — which is the common case and is not a failure. A call where
 * nothing was agreed should produce silence, not a notification asking you to
 * confirm nothing.
 */
export async function proposeFromCall(input: CallProposalInput): Promise<string | null> {
  const { callId, recordId, module, userId, analysis } = input;
  if (!userId) return null;

  const meta = await registry.getModule(module);
  if (!meta) return null;

  const current = await db.queryOne<{ status: string | null; next_followup_at: string | null; label: string }>(
    `SELECT l.status, l.next_followup_at, r.label
     FROM ipy_e_leads l JOIN ipy_record r ON r.id = l.record_id
     WHERE l.record_id = $1`,
    [recordId],
  );
  if (!current) return null;

  const updates: Record<string, unknown> = {};
  const changes: { field: string; label: string; from: unknown; to: unknown }[] = [];

  // Found by its storage column, not its API name, so an admin who renames
  // "Lead Status" to anything they like keeps this working. See fieldPlaying.
  const statusField = registry.fieldPlaying(meta, 'status');
  const proposedStatus = analysis.suggestedStatus?.trim();
  if (
    statusField && proposedStatus
    && proposedStatus !== current.status
    // A model that invents a stage produces a proposal that dies at confirm
    // time with a validation error, which reads to the rep as the CRM being
    // broken. Checked here, against the picklist the admin actually has.
    && statusField.options?.some((o) => o.value === proposedStatus)
  ) {
    updates[statusField.name] = proposedStatus;
    changes.push({ field: statusField.name, label: statusField.label, from: current.status, to: proposedStatus });
  }

  const followUp = normaliseFollowUp(analysis.followUpDate);
  if (followUp && followUp !== (current.next_followup_at ?? '').slice(0, 10)) {
    const field = registry.fieldPlaying(meta, 'next_followup_at');
    if (field) {
      updates[field.name] = followUp;
      changes.push({
        field: 'next_followup_at', label: field.label,
        from: current.next_followup_at, to: followUp,
      });
    }
  }

  if (!changes.length) {
    logger.debug({ callId, recordId }, 'call implied no record change worth proposing');
    return null;
  }

  const preview = describe(changes, analysis);

  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_ai_action
       (user_id, thread_id, action_type, module_name, record_id, payload, preview, origin, expires_at)
     VALUES ($1, NULL, 'update_record', $2, $3, $4::jsonb, $5, 'call', now() + ($6 || ' hours')::interval)
     RETURNING id`,
    [
      userId, module, recordId,
      JSON.stringify({ updates, changes, recordLabel: current.label, callId }),
      preview, String(PROPOSAL_TTL_HOURS),
    ],
  );
  if (!row) return null;

  await notify({
    userId,
    kind: 'call_followup',
    title: `Update ${current.label} after your call?`,
    body: preview,
    link: `/${module}/${recordId}`,
    recordId,
  });

  logger.info({ callId, recordId, changes: changes.map((c) => c.field) }, 'proposed record update from call');
  return row.id;
}

/**
 * The one line the rep reads on a lock screen.
 *
 * Leads with *why*, because the reason is what makes it checkable. "Move to
 * Site Visit Scheduled" invites a reflexive yes; "she agreed to visit Saturday,
 * so: Site Visit Scheduled" invites the rep to notice if that is not what
 * happened.
 */
function describe(
  changes: { label: string; to: unknown }[],
  analysis: CallAnalysis,
): string {
  const what = changes.map((c) => `${c.label} → ${formatValue(c.to)}`).join(', ');
  const why = analysis.followUpReason?.trim();
  return why ? `${why}. ${what}` : what;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  }
  return String(value);
}

/**
 * A follow-up date that is real, in the future, and not absurd.
 *
 * Three ways a model gets this wrong, all seen in practice: a date in the past
 * (it did not know today's date), a date years out (it read "next year" from a
 * possession discussion rather than a callback), and a malformed string. Any of
 * them silently poisons the follow-up list, which is the one screen a rep works
 * from every morning.
 */
function normaliseFollowUp(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const when = new Date(`${value}T00:00:00`);
  if (Number.isNaN(when.getTime())) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (when < today) return null;

  const oneYearOut = new Date(today);
  oneYearOut.setFullYear(oneYearOut.getFullYear() + 1);
  if (when > oneYearOut) return null;

  return value;
}
