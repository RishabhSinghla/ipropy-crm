/**
 * Drip sequences — the follow-up that happens whether or not anyone remembers.
 *
 * A sequence is an ordered list of steps with delays. An enrolment is one
 * person walking through it. The scheduler wakes up, finds enrolments whose
 * `next_run_at` has passed, runs one step each and sets the next wake-up.
 *
 * Almost all of the design here is about *stopping*, because an automated
 * follow-up that will not stop is worse than no follow-up at all:
 *
 *  * Someone replies → they are in a conversation with a human now. Exit.
 *  * Someone opts out → exit, and never re-enrol.
 *  * The lead reaches a terminal status (Won, Lost, Junk) → exit.
 *  * It is 2am → wait until morning. Nothing markets itself at 2am and
 *    survives.
 *
 * The fifth stop condition is the one people forget: a step that cannot send
 * *must not* silently vanish. Outside the 24-hour window, with no approved
 * template, the step falls back to the device queue so a human finishes the
 * job. A sequence that quietly drops half its steps looks like it is working.
 */
import { db } from '../../db/pool.js';
import { toInternational } from '@ipropy/shared';
import { logger } from '../../utils/logger.js';
import { withNameParts } from '../../core/entity/nameParts.js';
import { NotFoundError } from '../../utils/errors.js';
import { isOptedOut } from './consent.js';
import { getOrCreateConversation, isWindowOpen, sendMessage } from './service.js';
import { queueDeviceSend, renderForRecord } from './deviceSend.js';
import * as provider from './provider.js';

interface SequenceRow {
  id: string;
  name: string;
  module_name: string;
  exit_on_reply: boolean;
  exit_on_status: string[];
  quiet_start: number;
  quiet_end: number;
}

interface StepRow {
  id: string;
  sequence: number;
  delay_minutes: number;
  channel: 'whatsapp' | 'email' | 'task' | 'sms';
  template_name: string | null;
  subject: string | null;
  body: string | null;
  buttons: { id: string; title: string }[];
  fallback_to_device: boolean;
}

/**
 * Put someone into a sequence.
 *
 * The unique constraint on (sequence_id, record_id) does the real work: a
 * workflow that fires twice, an import run again, or a rep clicking Enrol on a
 * lead already in the sequence must not produce two parallel drips at the same
 * person.
 */
export async function enrol(input: {
  sequenceId: string;
  recordId: string;
  handle?: string;
  enrolledBy?: string | null;
}): Promise<{ enrolled: boolean; reason?: string }> {
  const sequence = await db.queryOne<SequenceRow>(
    `SELECT id, name, module_name, exit_on_reply, exit_on_status, quiet_start, quiet_end
     FROM ipy_outreach_sequence WHERE id = $1 AND is_active = true`,
    [input.sequenceId],
  );
  if (!sequence) return { enrolled: false, reason: 'Sequence not found or inactive' };

  const handle = input.handle ?? await handleForRecord(input.recordId);
  if (!handle) return { enrolled: false, reason: 'No WhatsApp number on this record' };

  if (await isOptedOut(handle)) {
    return { enrolled: false, reason: 'This number has opted out' };
  }

  const first = await db.queryOne<{ delay_minutes: number }>(
    `SELECT delay_minutes FROM ipy_outreach_sequence_step
     WHERE sequence_id = $1 AND is_active ORDER BY sequence LIMIT 1`,
    [input.sequenceId],
  );
  if (!first) return { enrolled: false, reason: 'This sequence has no steps yet' };

  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_outreach_sequence_enrolment (sequence_id, record_id, handle, next_run_at, enrolled_by)
     VALUES ($1,$2,$3, now() + ($4 || ' minutes')::interval, $5)
     ON CONFLICT (sequence_id, record_id) DO NOTHING
     RETURNING id`,
    [input.sequenceId, input.recordId, handle, String(first.delay_minutes), input.enrolledBy ?? null],
  );
  if (!row) return { enrolled: false, reason: 'Already enrolled in this sequence' };

  await db.query(
    `UPDATE ipy_outreach_sequence SET enrolled_count = enrolled_count + 1 WHERE id = $1`,
    [input.sequenceId],
  );
  return { enrolled: true };
}

export async function exitEnrolment(enrolmentId: string, reason: string): Promise<void> {
  await db.query(
    `UPDATE ipy_outreach_sequence_enrolment
     SET status = 'exited', exit_reason = $2, next_run_at = NULL,
         claimed_at = NULL, updated_at = now()
     WHERE id = $1 AND status IN ('active','processing')`,
    [enrolmentId, reason],
  );
}

/**
 * Everyone in any sequence, for this record, out.
 *
 * Called when a lead replies or reaches a terminal status. Takes the record
 * rather than the enrolment because the caller knows a person changed, not
 * which of the four sequences they happen to be in.
 */
export async function exitAllForRecord(recordId: string, reason: string): Promise<number> {
  const result = await db.query(
    `UPDATE ipy_outreach_sequence_enrolment
     SET status = 'exited', exit_reason = $2, next_run_at = NULL,
         claimed_at = NULL, updated_at = now()
     WHERE record_id = $1 AND status IN ('active','processing')`,
    [recordId, reason],
  );
  return result.rowCount ?? 0;
}

/** Same, by phone number — an inbound reply knows the handle, not the record. */
export async function exitAllForHandle(handle: string, reason: string): Promise<number> {
  const tail = handle.replace(/\D/g, '').slice(-10);
  const result = await db.query(
    `UPDATE ipy_outreach_sequence_enrolment
     SET status = 'exited', exit_reason = $2, next_run_at = NULL,
         claimed_at = NULL, updated_at = now()
     WHERE status IN ('active','processing')
       AND right(regexp_replace(handle, '\\D', '', 'g'), 10) = $1`,
    [tail, reason],
  );
  return result.rowCount ?? 0;
}

/**
 * Advance every enrolment that is due. Called on each scheduler tick.
 *
 * Rows are claimed with FOR UPDATE SKIP LOCKED so two server instances never
 * run the same step twice — the same discipline the workflow queue uses.
 */
export async function runDueEnrolments(limit = 50): Promise<{ ran: number; exited: number }> {
  let ran = 0;
  let exited = 0;

  const due = await db.query<{
    id: string; sequence_id: string; record_id: string | null; handle: string;
    current_step: number; enrolled_by: string | null; created_at: string;
  }>(
    `UPDATE ipy_outreach_sequence_enrolment e
     SET status = 'processing', claimed_at = now(), updated_at = now()
     WHERE e.id IN (
       SELECT id FROM ipy_outreach_sequence_enrolment
       WHERE (
         status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= now()
       ) OR (
         status = 'processing' AND claimed_at < now() - interval '15 minutes'
       )
       ORDER BY next_run_at NULLS FIRST
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING e.id, e.sequence_id, e.record_id, e.handle, e.current_step,
               e.enrolled_by, e.created_at`,
    [limit],
  );

  for (const enrolment of due.rows) {
    try {
      const outcome = await advance(enrolment);
      if (outcome === 'exited') exited++; else if (outcome === 'ran') ran++;
    } catch (err) {
      logger.warn({ err, enrolmentId: enrolment.id }, 'sequence step failed');
      await db.query(
        `UPDATE ipy_outreach_sequence_enrolment
         SET status = 'active', claimed_at = NULL, last_error = $2,
             next_run_at = now() + interval '1 hour', updated_at = now()
         WHERE id = $1`,
        [enrolment.id, (err instanceof Error ? err.message : String(err)).slice(0, 500)],
      );
    }
  }

  return { ran, exited };
}

type Outcome = 'ran' | 'exited' | 'deferred';

async function advance(enrolment: {
  id: string; sequence_id: string; record_id: string | null; handle: string;
  current_step: number; enrolled_by: string | null; created_at: string;
}): Promise<Outcome> {
  const sequence = await db.queryOne<SequenceRow>(
    `SELECT id, name, module_name, exit_on_reply, exit_on_status, quiet_start, quiet_end
     FROM ipy_outreach_sequence WHERE id = $1`,
    [enrolment.sequence_id],
  );
  if (!sequence) {
    await exitEnrolment(enrolment.id, 'Sequence deleted');
    return 'exited';
  }

  // --- stop conditions, cheapest first ------------------------------------

  if (await isOptedOut(enrolment.handle)) {
    await exitEnrolment(enrolment.id, 'Opted out');
    return 'exited';
  }

  if (sequence.exit_on_reply && await hasReplied(enrolment.handle, enrolment.created_at)) {
    await exitEnrolment(enrolment.id, 'Replied');
    return 'exited';
  }

  if (enrolment.record_id && sequence.exit_on_status?.length) {
    const lead = await db.queryOne<{ status: string | null }>(
      `SELECT status FROM ipy_e_leads WHERE record_id = $1`, [enrolment.record_id],
    );
    if (lead?.status && sequence.exit_on_status.includes(lead.status)) {
      await exitEnrolment(enrolment.id, `Reached status ${lead.status}`);
      return 'exited';
    }
  }

  // Quiet hours: push to the next opening rather than sending or skipping.
  const wait = minutesUntilAwake(sequence.quiet_start, sequence.quiet_end);
  if (wait > 0) {
    await db.query(
      `UPDATE ipy_outreach_sequence_enrolment
       SET status = 'active', claimed_at = NULL,
           next_run_at = now() + ($2 || ' minutes')::interval, updated_at = now()
       WHERE id = $1`,
      [enrolment.id, String(wait)],
    );
    return 'deferred';
  }

  // --- the step -----------------------------------------------------------

  const step = await db.queryOne<StepRow>(
    `SELECT id, sequence, delay_minutes, channel, template_name, subject, body, buttons, fallback_to_device
     FROM ipy_outreach_sequence_step
     WHERE sequence_id = $1 AND is_active AND sequence > $2
     ORDER BY sequence LIMIT 1`,
    [enrolment.sequence_id, enrolment.current_step],
  );

  if (!step) {
    await db.query(
      `UPDATE ipy_outreach_sequence_enrolment
       SET status = 'completed', claimed_at = NULL, next_run_at = NULL, updated_at = now()
       WHERE id = $1`,
      [enrolment.id],
    );
    return 'exited';
  }

  await runStep(step, enrolment, sequence);

  // The cursor moves whether or not the step managed to send. A step that
  // could not go out is logged inside runStep; re-running it forever would
  // wedge the enrolment on one unsendable message and starve every step after.
  const next = await db.queryOne<{ delay_minutes: number }>(
    `SELECT delay_minutes FROM ipy_outreach_sequence_step
     WHERE sequence_id = $1 AND is_active AND sequence > $2
     ORDER BY sequence LIMIT 1`,
    [enrolment.sequence_id, step.sequence],
  );

  if (next) {
    await db.query(
      `UPDATE ipy_outreach_sequence_enrolment
       SET current_step = $2, status = 'active', claimed_at = NULL,
           next_run_at = now() + ($3 || ' minutes')::interval,
           last_error = NULL, updated_at = now()
       WHERE id = $1`,
      [enrolment.id, step.sequence, String(next.delay_minutes)],
    );
  } else {
    await db.query(
      `UPDATE ipy_outreach_sequence_enrolment
       SET current_step = $2, status = 'completed', claimed_at = NULL,
           next_run_at = NULL, last_error = NULL, updated_at = now()
       WHERE id = $1`,
      [enrolment.id, step.sequence],
    );
  }

  return 'ran';
}

async function runStep(
  step: StepRow,
  enrolment: { id: string; handle: string; record_id: string | null; enrolled_by: string | null },
  sequence: SequenceRow,
): Promise<void> {
  const body = step.body
    ? await renderForRecord(step.body, enrolment.record_id, sequence.module_name)
    : '';

  switch (step.channel) {
    case 'whatsapp': {
      await sendWhatsAppStep(step, enrolment, sequence, body);
      break;
    }
    case 'email': {
      if (!enrolment.record_id) break;
      const lead = await db.queryOne<{ email: string | null }>(
        `SELECT email FROM ipy_e_leads WHERE record_id = $1`, [enrolment.record_id],
      );
      if (!lead?.email) break;
      const { sendEmail } = await import('../email/service.js');
      await sendEmail({
        to: lead.email,
        subject: step.subject ?? sequence.name,
        html: `<p>${body.replace(/\n/g, '<br>')}</p>`,
        recordId: enrolment.record_id,
      });
      break;
    }
    case 'task': {
      // A step a machine should not do on its own — "ring them and ask about
      // the loan" — lands on the owner as a dated follow-up with the step's
      // text on the record's timeline.
      if (!enrolment.record_id) break;
      const { scheduleFollowUp } = await import('../../core/workflow/followUp.js');
      await scheduleFollowUp({
        recordId: enrolment.record_id,
        module: sequence.module_name,
        on: new Date(Date.now() + 60 * 60_000),
        reason: step.subject ?? `${sequence.name} — step ${step.sequence}`,
        notes: body,
        onlyIfSooner: true,
      });
      break;
    }
    case 'sms':
      logger.info({ step: step.id }, 'sequence sms step skipped — no SMS provider configured');
      break;
  }
}

/**
 * Send one WhatsApp step, choosing the path that will actually work.
 *
 * Order matters and encodes the real constraints: a free-form message inside an
 * open window is the best outcome, an approved template is the fallback outside
 * it, and a device hand-off is what keeps the step from evaporating when
 * neither is available.
 */
async function sendWhatsAppStep(
  step: StepRow,
  enrolment: { id: string; handle: string; record_id: string | null; enrolled_by: string | null },
  sequence: SequenceRow,
  body: string,
): Promise<void> {
  const apiReady = await provider.isConfigured();

  if (apiReady) {
    const conversationId = await getOrCreateConversation(enrolment.handle);
    const windowOpen = await isWindowOpen(conversationId);

    if (windowOpen && body) {
      await sendMessage({
        conversationId,
        text: body,
        buttons: step.buttons?.length ? step.buttons : undefined,
      });
      return;
    }
    if (step.template_name) {
      const { bindTemplateParams } = await import('./service.js');
      const params = await bindTemplateParams(step.template_name, await mergeScope(enrolment.record_id, sequence.module_name));
      await sendMessage({ conversationId, templateName: step.template_name, templateParams: params });
      return;
    }
  }

  if (step.fallback_to_device && body) {
    await queueDeviceSend({
      handle: enrolment.handle,
      body,
      recordId: enrolment.record_id,
      module: sequence.module_name,
      reason: `${sequence.name} — step ${step.sequence}`,
      sequenceId: sequence.id,
      assignedTo: enrolment.enrolled_by,
    });
    return;
  }

  logger.info(
    { step: step.id, handle: enrolment.handle },
    'sequence whatsapp step skipped — window closed, no template, device fallback off',
  );
}

async function mergeScope(recordId: string | null, module: string): Promise<Record<string, unknown>> {
  if (!recordId) return {};
  const { registry } = await import('../../core/metadata/registry.js');
  const meta = await registry.requireModule(module);
  const row = await db.queryOne<Record<string, unknown>>(
    `SELECT r.label, e.* FROM ipy_record r JOIN ${meta.tableName} e ON e.record_id = r.id WHERE r.id = $1`,
    [recordId],
  );
  if (!row) return {};
  return withNameParts(row);
}

/** Any inbound message from this number since it was enrolled counts as a reply. */
async function hasReplied(handle: string, enrolledAt: string): Promise<boolean> {
  const tail = handle.replace(/\D/g, '').slice(-10);
  const row = await db.queryOne<{ id: string }>(
    `SELECT m.id FROM ipy_message m
     JOIN ipy_conversation c ON c.id = m.conversation_id
     WHERE m.direction = 'inbound'
       AND right(regexp_replace(c.handle, '\\D', '', 'g'), 10) = $1
       AND m.created_at >= $2
     LIMIT 1`,
    [tail, enrolledAt],
  );
  return Boolean(row);
}

/**
 * Minutes to wait if we are inside quiet hours, else 0.
 *
 * Handles the wrap across midnight, which is the normal case: quiet from 21:00
 * to 09:00 is not a range you can compare with two `<`s.
 */
export function minutesUntilAwake(quietStart: number, quietEnd: number, now = new Date()): number {
  if (quietStart === quietEnd) return 0;
  const hour = now.getHours();
  const minute = now.getMinutes();

  const inQuiet = quietStart > quietEnd
    ? hour >= quietStart || hour < quietEnd   // wraps midnight
    : hour >= quietStart && hour < quietEnd;

  if (!inQuiet) return 0;

  const hoursUntil = hour < quietEnd ? quietEnd - hour : 24 - hour + quietEnd;
  return hoursUntil * 60 - minute;
}

async function handleForRecord(recordId: string): Promise<string | null> {
  const row = await db.queryOne<{ whatsapp_number: string | null; mobile: string | null; country_code: string | null }>(
    `SELECT whatsapp_number, mobile, country_code FROM ipy_e_leads WHERE record_id = $1`, [recordId],
  );
  return toInternational(row?.country_code, row?.whatsapp_number || row?.mobile);
}

export async function requireSequence(id: string): Promise<SequenceRow> {
  const row = await db.queryOne<SequenceRow>(`SELECT * FROM ipy_outreach_sequence WHERE id = $1`, [id]);
  if (!row) throw new NotFoundError('Sequence not found');
  return row;
}
