/**
 * Make the CRM's list of AI calls agree with Sarvam's, whatever happened to the webhook.
 *
 * Three jobs, one pass:
 *  1. a call still "queued" whose attempt Sarvam has finished is completed (a webhook that never arrived used to leave
 *     it stuck, and the dial queue stops for a call it cannot account for);
 *  2. a call the CRM completed before it kept the conversation id gets the id, so its recording plays, and gets the
 *     outcome, summary and follow-up the post-call steps give a new call;
 *  3. a call Sarvam made that the CRM never placed (a campaign launched in Sarvam's dashboard, an inbound call whose
 *     callback was lost) is written onto the right record's timeline.
 * Nothing is dialled, and nothing is changed that a person already decided: a disposition somebody set stays.
 */
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { matchContact } from '../whatsapp/matchContact.js';
import { toE164 } from '@ipropy/shared';
import { readSarvamSettings, recordSarvamResult, SARVAM_PROVIDER, type SarvamResult, type SarvamSettings } from './sarvam.js';
import { listAttempts, listInteractions, type SarvamAttempt, type SarvamInteraction } from './analytics.js';
import { finishAiCall } from './afterCall.js';

export interface ReconcileReport {
  ok: boolean;
  checked: number;
  completed: number;
  backfilled: number;
  enriched: number;
  skipped: number;
  message: string;
  at: string;
}

/** A call that began less than this long ago may still be going; it is left for the webhook. */
const STILL_RINGING_MS = 5 * 60_000;
const MAX_HOURS = 14 * 24;

const NOTHING = (value: string | null | undefined): boolean => !value || /^(NO_FAILURE_REASON|NO_END_REASON|UNKNOWN)$/i.test(value);

/** The English transcript as the CRM writes it everywhere else. */
export function transcriptOf(interaction: SarvamInteraction | undefined): string | null {
  const turns = interaction?.translate_transcript?.length ? interaction.translate_transcript : interaction?.original_transcript ?? [];
  const lines = turns.filter((turn) => turn.text?.trim()).map((turn) => `${turn.role === 'agent' || turn.role === 'assistant' ? 'AI agent' : 'Customer'}: ${turn.text.trim()}`);
  return lines.length ? lines.join('\n') : null;
}

/** One attempt (and its conversation, when it has one) as the result the webhook would have delivered. */
export function resultFromAttempt(attempt: SarvamAttempt, interaction: SarvamInteraction | undefined): SarvamResult | null {
  if (!attempt.attempt_id) return null;
  const connected = attempt.connectivity_status === 'connected' || Boolean(attempt.interaction_id);
  const status: SarvamResult['status'] = connected ? 'connected'
    : attempt.connectivity_status === 'busy' ? 'busy'
      : attempt.connectivity_status === 'no_answer' ? 'no_answer' : 'failed';
  return {
    attemptId: attempt.attempt_id,
    interactionId: attempt.interaction_id ?? null,
    status,
    durationSeconds: Math.round(attempt.duration_in_seconds ?? 0),
    failureReason: NOTHING(attempt.failure_reason) ? null : attempt.failure_reason!,
    transcript: transcriptOf(interaction),
    finalAgentVariables: interaction?.agent_variables ?? attempt.agent_variables ?? null,
  };
}

/** The apps (agents) the CRM calls through, each with the module it serves. */
export function appsOf(settings: SarvamSettings): Array<{ appId: string; module: string | null }> {
  const apps = new Map<string, string | null>();
  for (const [module, agent] of Object.entries(settings.agentsByModule)) if (agent.appId) apps.set(agent.appId, module);
  if (settings.appId && !apps.has(settings.appId)) apps.set(settings.appId, null);
  return [...apps].map(([appId, module]) => ({ appId, module }));
}

export async function reconcileSarvam(options: { hours?: number } = {}): Promise<ReconcileReport> {
  const report: ReconcileReport = { ok: true, checked: 0, completed: 0, backfilled: 0, enriched: 0, skipped: 0, message: '', at: new Date().toISOString() };
  const read = readSarvamSettings();
  if ('missing' in read) return { ...report, ok: false, message: read.missing };
  const hours = Math.min(Math.max(options.hours ?? 48, 1), MAX_HOURS);
  const to = new Date();
  const from = new Date(to.getTime() - hours * 3_600_000);

  try {
    for (const app of appsOf(read.settings)) {
      const [attempts, interactions] = await Promise.all([
        listAttempts(read.settings, app.appId, from, to),
        listInteractions(read.settings, app.appId, from, to),
      ]);
      const byInteraction = new Map(interactions.map((item) => [item.interaction_id ?? '', item]));
      for (const attempt of attempts) {
        if (!attempt.attempt_id || attempt.is_debug_call === 1) { report.skipped += 1; continue; }
        report.checked += 1;
        await reconcileOne(attempt, byInteraction.get(attempt.interaction_id ?? ''), app, report);
      }
    }
    report.message = `Checked ${report.checked} calls: ${report.completed} completed, ${report.backfilled} added, ${report.enriched} given their outcome and recording.`;
  } catch (err) {
    logger.warn({ err }, 'sarvam: reconciliation stopped');
    return { ...report, ok: false, message: `Stopped early: ${err instanceof Error ? err.message : String(err)}` };
  }
  await db.query(`UPDATE ipy_integration SET last_sync_at = now(), last_error = NULL WHERE provider = $1`, [SARVAM_PROVIDER]).catch(() => undefined);
  return report;
}

async function reconcileOne(
  attempt: SarvamAttempt, interaction: SarvamInteraction | undefined, app: { appId: string; module: string | null }, report: ReconcileReport,
): Promise<void> {
  const known = await db.queryOne<{ id: string; status: string; sarvam_interaction_id: string | null; disposition: string | null; created_at: Date }>(
    `SELECT id, status, sarvam_interaction_id, disposition, created_at FROM ipy_call WHERE provider = $1 AND provider_call_id = $2`,
    [SARVAM_PROVIDER, attempt.attempt_id]);
  const result = resultFromAttempt(attempt, interaction);
  if (!result) return;

  if (known) {
    // 1. Placed here, never reported back.
    if (known.status === 'queued') {
      const started = Date.parse(attempt.attempted_at ?? '') || known.created_at.getTime();
      if (Date.now() - started < STILL_RINGING_MS) return;
      if (await recordSarvamResult(result)) report.completed += 1;
      return;
    }
    // 2. Reported, but without the conversation id (or the outcome the post-call steps give).
    const needsId = !known.sarvam_interaction_id && Boolean(result.interactionId);
    if (needsId) {
      await db.query(`UPDATE ipy_call SET sarvam_interaction_id = $2, sarvam_app_id = COALESCE(sarvam_app_id, $3) WHERE id = $1`,
        [known.id, result.interactionId, app.appId]);
    }
    if (needsId || (known.status === 'completed' && !known.disposition)) {
      await finishAiCall(known.id, { failureReason: result.failureReason, historical: Date.now() - known.created_at.getTime() > 2 * 3_600_000 });
      report.enriched += 1;
    }
    return;
  }

  // 3. A call the CRM never placed.
  const outbound = attempt.channel_direction !== 'inbound';
  const phone = toE164(attempt.user_contact ?? '');
  if (!phone) { report.skipped += 1; return; }
  const match = app.module ? await matchContact(app.module, phone) : { kind: 'none' as const };
  const recordId = match.kind === 'one' ? match.recordId : null;
  const owner = recordId ? await db.queryOne<{ owner_id: string | null }>(`SELECT owner_id FROM ipy_record WHERE id = $1`, [recordId]) : null;
  const started = attempt.start_datetime ? new Date(`${attempt.start_datetime}Z`) : attempt.attempted_at ? new Date(`${attempt.attempted_at}Z`) : new Date();
  const inserted = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_call (direction, from_number, to_number, status, provider, provider_call_id, source, record_id, record_module, user_id,
                           started_at, sarvam_app_id)
     SELECT $1, $2, $3, 'queued', $4, $5, 'sarvam', $6, $7, $8, $9, $10
      WHERE NOT EXISTS (SELECT 1 FROM ipy_call WHERE provider = $4 AND provider_call_id = $5)
     RETURNING id`,
    [outbound ? 'outbound' : 'inbound', outbound ? 'sarvam' : phone, outbound ? phone : 'sarvam', SARVAM_PROVIDER, attempt.attempt_id,
      recordId, recordId ? app.module : null, owner?.owner_id ?? null, started, app.appId]);
  if (!inserted) return;
  if (await recordSarvamResult(result)) report.backfilled += 1;
}

let lastReport: ReconcileReport | null = null;
export const lastSarvamReconcile = (): ReconcileReport | null => lastReport;
/** The routes and the timer both go through here so "when did it last agree with Sarvam" has one answer. */
export async function reconcileAndRemember(options: { hours?: number } = {}): Promise<ReconcileReport> {
  lastReport = await reconcileSarvam(options);
  return lastReport;
}

export interface HealthCheck { label: string; status: 'ok' | 'warn' | 'fail'; detail: string }

/** One screen's worth of "is the AI caller properly connected", each line a fact somebody can act on. */
export async function sarvamHealth(publicBaseUrl: string): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];
  const read = readSarvamSettings();
  if ('missing' in read) return [{ label: 'Sarvam card', status: 'fail', detail: read.missing }];
  const { settings } = read;
  const { testSarvamConnection, sarvamWebhookUrl } = await import('./sarvam.js');
  const connection = await testSarvamConnection();
  checks.push({ label: 'Key, organisation and workspace', status: connection.ok ? 'ok' : 'fail', detail: connection.message });

  const apps = appsOf(settings);
  checks.push({ label: 'Agents', status: apps.length ? 'ok' : 'fail',
    detail: apps.length ? apps.map((app) => `${app.module ?? 'default'}: ${app.appId}`).join(' · ') : 'No agent is mapped to a module.' });
  for (const [module, agent] of Object.entries(settings.agentsByModule)) {
    const connectionId = agent.connectionId || settings.connectionId;
    const phone = agent.agentPhoneNumber || settings.agentPhoneNumber;
    if (!connectionId || !phone) checks.push({ label: `${module} can place calls`, status: 'fail', detail: 'No telephony connection ID or agent phone number.' });
  }
  const url = sarvamWebhookUrl(publicBaseUrl, settings.webhookSecret).replace(settings.webhookSecret, '…');
  checks.push({ label: 'Result address', status: /^https:\/\//.test(publicBaseUrl) ? 'ok' : 'warn',
    detail: /^https:\/\//.test(publicBaseUrl) ? `Sarvam posts finished calls to ${url}` : `The CRM's public address is not https (${publicBaseUrl}); Sarvam may refuse to call it.` });

  const day = await db.queryOne<{ total: number; completed: number; stuck: number; no_outcome: number; no_recording: number; last: Date | null }>(
    `SELECT count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS total,
            count(*) FILTER (WHERE created_at > now() - interval '24 hours' AND status = 'completed')::int AS completed,
            count(*) FILTER (WHERE status = 'queued' AND created_at < now() - interval '15 minutes')::int AS stuck,
            count(*) FILTER (WHERE status = 'completed' AND disposition IS NULL)::int AS no_outcome,
            count(*) FILTER (WHERE status = 'completed' AND sarvam_interaction_id IS NULL)::int AS no_recording,
            max(created_at) AS last
       FROM ipy_call WHERE source = 'sarvam'`);
  checks.push({ label: 'Calls in the last 24 hours', status: 'ok', detail: `${day?.total ?? 0} placed, ${day?.completed ?? 0} answered. Last one: ${day?.last ? day.last.toISOString() : 'never'}.` });
  checks.push({ label: 'Calls waiting for a result', status: (day?.stuck ?? 0) ? 'warn' : 'ok',
    detail: (day?.stuck ?? 0) ? `${day!.stuck} calls have waited over 15 minutes; "Sync from Sarvam" asks Sarvam what happened to them.` : 'None stuck.' });
  checks.push({ label: 'Answered calls with an outcome and a recording', status: (day?.no_outcome ?? 0) || (day?.no_recording ?? 0) ? 'warn' : 'ok',
    detail: (day?.no_outcome ?? 0) || (day?.no_recording ?? 0)
      ? `${day?.no_outcome ?? 0} without an outcome, ${day?.no_recording ?? 0} without a recording link. "Sync from Sarvam" fills them in.` : 'Every answered call has both.' });
  const last = lastReport;
  checks.push({ label: 'Last check against Sarvam', status: !last ? 'warn' : last.ok ? 'ok' : 'fail', detail: last ? `${last.at}: ${last.message}` : 'Not yet since the server started; it runs every ten minutes.' });
  return checks;
}
