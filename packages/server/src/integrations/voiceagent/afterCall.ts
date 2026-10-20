/**
 * Everything the CRM does once an AI call has been recorded, so a finished call leaves a rep something to act on.
 *
 * Every step is best-effort and separate: a failure in one is logged and the next still runs, and none of them
 * throws, because the caller is a webhook that must answer Sarvam and a reconciler that must carry on to the next
 * call. The facts themselves (status, duration, transcript, extracted variables) are already written by then.
 */
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { activeValues } from '../../core/metadata/picklists.js';
import { isOptedOut, recordConsent } from '../../core/consent/index.js';
import { notify } from '../../core/notifications/index.js';
import { dispositionFor, isDoNotDisturbFailure, readSarvamOutcome, ruleSummary } from './outcome.js';

interface CallRow {
  id: string; direction: string; status: string; from_number: string; to_number: string; duration_seconds: number;
  transcript: string | null; notes: string | null; disposition: string | null; record_id: string | null; record_module: string | null;
  user_id: string | null; sarvam_interaction_id: string | null;
}

async function step(name: string, callId: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    logger.warn({ err, callId, step: name }, 'sarvam: a post-call step failed');
  }
}

/** The customer's number, whichever way the call went. */
const customerNumber = (call: Pick<CallRow, 'direction' | 'from_number' | 'to_number'>): string =>
  call.direction === 'inbound' ? call.from_number : call.to_number;

/** `historical`: the call is old news. It is classified and its recording kept, but nobody is told and no date is set. */
export async function finishAiCall(callId: string, input: { failureReason?: string | null; historical?: boolean } = {}): Promise<void> {
  const call = await db.queryOne<CallRow>(
    `SELECT id, direction, status, from_number, to_number, duration_seconds, transcript, notes, disposition,
            record_id, record_module, user_id, sarvam_interaction_id
       FROM ipy_call WHERE id = $1`, [callId]);
  if (!call) return;

  const outcome = readSarvamOutcome({ status: call.status, transcript: call.transcript, durationSeconds: call.duration_seconds });

  // 1. A disposition and a one-line summary, unless the agent or a person already supplied them.
  await step('outcome', callId, async () => {
    if (!outcome) return;
    const options = await activeValues('call_disposition');
    const disposition = call.disposition ? null : dispositionFor(outcome.kind, options);
    await db.query(
      `UPDATE ipy_call
          SET disposition = COALESCE(disposition, $2),
              disposition_at = CASE WHEN disposition IS NULL AND $2::text IS NOT NULL THEN now() ELSE disposition_at END,
              ai_summary = COALESCE(ai_summary, $3),
              sarvam_meta = COALESCE(sarvam_meta, '{}'::jsonb) || jsonb_build_object('outcome', $4::text, 'spoke', $5::boolean)
        WHERE id = $1`,
      [callId, disposition, ruleSummary(outcome, { transcript: call.transcript, durationSeconds: call.duration_seconds }), outcome.kind, outcome.spoke]);
  });

  // 2. Nobody is rung again after saying so, or after the telephone network says the number is on the DND register.
  await step('do-not-call', callId, async () => {
    const dnd = isDoNotDisturbFailure(input.failureReason ?? call.notes);
    if (!outcome?.stopCalling && !dnd) return;
    const number = customerNumber(call);
    if (await isOptedOut(number, 'call')) return;
    await recordConsent({ handle: number, channel: 'call', action: 'opt_out', source: 'call_disposition', recordId: call.record_id,
      messageText: dnd ? `Telephone network: ${(input.failureReason ?? call.notes ?? '').slice(0, 200)}` : 'Asked the AI agent not to call again' });
    if (call.record_id && call.record_module) await markDoNotCall(call.record_id, call.record_module);
  });

  // 3. "Call me tomorrow" becomes a date on the record, unless there is already an earlier one.
  await step('call-back', callId, async () => {
    if (input.historical || outcome?.kind !== 'callback' || !call.record_id || !call.record_module) return;
    const { scheduleFollowUp } = await import('../../core/workflow/followUp.js');
    const tomorrow = new Date(Date.now() + 24 * 3_600_000);
    await scheduleFollowUp({
      recordId: call.record_id, module: call.record_module, on: tomorrow, onlyIfSooner: true,
      reason: 'The customer asked the AI agent to call back', notes: 'Set from the AI call — change the date if they gave a time.',
      ownerId: null, authorId: null,
    });
  });

  // 4. The recording is Sarvam's; the CRM streams it on request (telephony.ts, GET /calls/:id/recording).
  await step('recording', callId, async () => {
    if (!call.sarvam_interaction_id) return;
    await db.query(`UPDATE ipy_call SET recording_url = COALESCE(recording_url, $2) WHERE id = $1`, [callId, `sarvam:${call.sarvam_interaction_id}`]);
  });

  // 5. A real conversation is worth the owner's attention now, not when they next open the list.
  await step('tell-the-owner', callId, async () => {
    if (input.historical || !outcome || !(outcome.kind === 'conversation' && outcome.spoke) && outcome.kind !== 'callback') return;
    if (!call.record_id || !call.record_module) return;
    const owner = await db.queryOne<{ owner_id: string | null; label: string }>(`SELECT owner_id, label FROM ipy_record WHERE id = $1`, [call.record_id]);
    if (!owner?.owner_id) return;
    await notify({
      userId: owner.owner_id, kind: 'call', recordId: call.record_id, link: `/${call.record_module}/${call.record_id}`,
      title: outcome.kind === 'callback' ? `${owner.label} asked the AI to call back` : `AI spoke with ${owner.label}`,
      body: ruleSummary(outcome, { transcript: call.transcript, durationSeconds: call.duration_seconds }).slice(0, 240),
    });
  });

  // 6. With a model available, the fuller read (sentiment, objections, next actions) follows; without one, the above stands.
  await step('analysis', callId, async () => {
    if (input.historical || !outcome?.spoke) return;
    const { analyseCallRecording } = await import('../../ai/callAnalysis.js');
    void analyseCallRecording(callId).catch((err) => logger.debug({ err, callId }, 'sarvam: call analysis unavailable'));
  });
}

async function markDoNotCall(recordId: string, moduleName: string): Promise<void> {
  const [{ recordService }, { registry }, { systemContext }] = await Promise.all([
    import('../../core/entity/recordService.js'),
    import('../../core/metadata/registry.js'),
    import('../../core/workflow/tasks.js'),
  ]);
  const module = await registry.getModule(moduleName);
  if (!module?.fields.some((field) => field.isActive && field.name === 'do_not_call')) return;
  await recordService.updateRecord(await systemContext(null), moduleName, recordId, { do_not_call: true }, { skipWorkflow: true });
}
