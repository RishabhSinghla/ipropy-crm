/**
 * Telling Meta which of its leads turned out good.
 *
 * **2 November 2026, the owner**, of Meta's own prompt: *"You could get 24% lower
 * cost per quality lead if you connect your CRM with Meta's Conversions API"* —
 * then, when asked whether to build it, *"A, yes build it"*.
 *
 * Facebook leads already come IN (`facebook.ts`). This is the line back OUT:
 * when one of those leads reaches a stage worth reporting (Qualified, Site
 * Visit Done, Converted by default) the CRM tells Meta once, so Meta learns
 * what a good lead looks like and finds more of them.
 *
 * What is sent, and what is deliberately not:
 *  - only leads that **came from a Facebook lead ad** — the ad's own lead id is
 *    how Meta matches the result. Anybody who came any other way is never sent;
 *  - the lead id, the stage name, the time, and the phone number and email as a
 *    one-way SHA-256 hash (Meta's own format). No name, no budget, no notes;
 *  - each (lead, stage) at most once — `ipy_meta_conversion` is the record and
 *    the guard, so a lead bouncing between stages is not counted twice.
 *
 * Switched off until the card is filled in and switched on, and a failure here
 * never fails a save (the event bus swallows it) — the row says what happened.
 */
import { createHash } from 'node:crypto';
import { picklistOptionForValue, statusFieldOf, toInternational } from '@ipropy/shared';
import { db } from '../../db/pool.js';
import { bus, type RecordEventPayload } from '../../core/events/bus.js';
import { getModule } from '../../core/metadata/registry.js';
import { getRecord, type ServiceContext } from '../../core/entity/recordService.js';
import { BadRequestError } from '../../utils/errors.js';
import { getIntegrationConfig, getIntegrationCredentials } from '../../core/settings/integrations.js';
import { logger } from '../../utils/logger.js';
import { FACEBOOK_GRAPH_VERSION } from './facebook.js';

export const DEFAULT_STAGES = 'Qualified, Site Visit Done, Converted';

/** The stages to report, from the card's comma-separated box. Blank means the defaults. */
export function wantedStages(setting: string | undefined): string[] {
  const list = (setting?.trim() ? setting : DEFAULT_STAGES)
    .split(',').map((stage) => stage.trim().toLowerCase()).filter(Boolean);
  return list;
}

/** Whether this status, by stored value or by its label, is one of the stages to report. */
export function isWantedStage(stages: string[], value: string, label: string): boolean {
  return stages.includes(value.trim().toLowerCase()) || stages.includes(label.trim().toLowerCase());
}

/** Meta's format: trimmed, lower case, then SHA-256 as hex. */
export function hashed(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

export interface ConversionInput {
  eventName: string;
  recordId: string;
  leadId: string;
  countryCode?: string | null;
  mobile?: string | null;
  email?: string | null;
  nowSeconds: number;
  testEventCode?: string;
}

/** The body Meta's `/{dataset}/events` expects, for one lead and one stage. */
export function buildConversionBody(input: ConversionInput): Record<string, unknown> {
  const phone = toInternational(input.countryCode, input.mobile);
  const email = input.email?.trim();
  const userData: Record<string, unknown> = {
    // A string, not a number: the ids are 15-17 digits and a JS number loses the end of them.
    lead_id: input.leadId,
    ...(phone ? { ph: [hashed(phone.replace(/\D/g, ''))] } : {}),
    ...(email ? { em: [hashed(email)] } : {}),
  };
  return {
    data: [{
      event_name: input.eventName,
      event_time: input.nowSeconds,
      // The same lead and stage always carry the same id, so Meta drops a repeat itself too.
      event_id: `${input.recordId}:${input.eventName}`,
      action_source: 'system_generated',
      user_data: userData,
      custom_data: { event_source: 'crm', lead_event_source: 'iPropy CRM' },
    }],
    ...(input.testEventCode ? { test_event_code: input.testEventCode } : {}),
  };
}

function graphUrl(path: string): string {
  const version = getIntegrationConfig('meta_conversions')?.apiVersion?.trim() || FACEBOOK_GRAPH_VERSION;
  return `https://graph.facebook.com/${version}/${path}`;
}

async function callMeta(method: 'GET' | 'POST', path: string, token: string, body?: unknown): Promise<Record<string, unknown>> {
  // The token travels in a header, never in the address, so no log of a URL can hold it.
  const res = await fetch(graphUrl(path), {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & Record<string, unknown>;
  if (!res.ok || json.error) throw new Error(json.error?.message ?? `Meta answered ${res.status}`);
  return json;
}

/**
 * The Test button.
 *
 * With a test code on the card it sends one test event (a real lead's id, since Meta
 * refuses a made-up one) under that code, which
 * Meta shows only in Events Manager → Test events and never in real reporting —
 * the same call a real lead makes, so it proves what matters: that Meta accepts
 * this token for sending. Without a test code it sends nothing and only reads
 * the dataset's name, because an invented event must never reach live data.
 * (A sending token is often not allowed to read the dataset, so that read can
 * refuse while sending works; the test event is the better proof.)
 */
export async function testMetaConversions(): Promise<{ ok: boolean; message: string }> {
  const conf = getIntegrationConfig('meta_conversions');
  const token = getIntegrationCredentials('meta_conversions')?.accessToken;
  if (!conf?.datasetId || !token) return { ok: false, message: 'Fill in the Dataset ID and the access token first.' };
  const datasetId = conf.datasetId.trim();
  const testCode = conf.testEventCode?.trim();
  // Meta's refusal is the answer this button exists to give. Letting it throw
  // reached the admin as "Something went wrong on our end" and hid the reason.
  try {
    if (testCode) {
      // Meta rejects an event whose lead id is not a real lead's ("Invalid parameter"),
      // so the test borrows the newest real Facebook lead's id. It travels under the
      // test code only, so it never reaches real reporting.
      const lead = await db.queryOne<{ external_id: string }>(
        `SELECT external_id FROM ipy_lead_inbox
          WHERE source = 'facebook' AND external_id IS NOT NULL
          ORDER BY received_at DESC LIMIT 1`,
      );
      if (!lead) return { ok: false, message: 'No Facebook lead has arrived yet, so there is no real lead id to test with.' };
      const body = buildConversionBody({
        eventName: 'Test',
        recordId: 'crm-test',
        leadId: lead.external_id,
        nowSeconds: Math.floor(Date.now() / 1000),
        testEventCode: testCode,
      });
      const answer = await callMeta('POST', `${datasetId}/events`, token, body);
      if (Number(answer.events_received) < 1) return { ok: false, message: 'Meta answered but did not take the test event.' };
      return { ok: true, message: `Meta took a test event under code ${testCode}. Look in Events Manager → Test events. It does not count in real reporting.` };
    }
    const dataset = await callMeta('GET', `${datasetId}?fields=id,name`, token);
    return { ok: true, message: `Connected to the Meta dataset "${String(dataset.name ?? dataset.id)}". Nothing was sent.` };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Meta refused: ${reason}` };
  }
}

/** One send, claimed first so two saves racing cannot both tell Meta. */
async function claim(recordId: string, eventName: string, leadId: string): Promise<boolean> {
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_meta_conversion (record_id, event_name, lead_id) VALUES ($1, $2, $3)
     ON CONFLICT (record_id, event_name) DO UPDATE
       SET status = 'sending', attempts = ipy_meta_conversion.attempts + 1, error = NULL, created_at = now()
       WHERE ipy_meta_conversion.status = 'failed'
          OR (ipy_meta_conversion.status = 'sending' AND ipy_meta_conversion.created_at < now() - interval '10 minutes')
     RETURNING id`,
    [recordId, eventName, leadId],
  );
  return Boolean(row);
}

export async function reportLeadStage(p: RecordEventPayload): Promise<void> {
  const conf = getIntegrationConfig('meta_conversions');
  const token = getIntegrationCredentials('meta_conversions')?.accessToken;
  // Off, or half filled in: nothing happens, and nobody is told anything.
  if (!conf?.datasetId || !token) return;

  const module = await getModule(p.module);
  const status = module ? statusFieldOf(module.fields) : undefined;
  if (!module || !status || !p.changedFields?.includes(status.name)) return;

  const value = String(p.record[status.name] ?? '');
  const label = picklistOptionForValue(status.options, value)?.label ?? value;
  if (!value || !isWantedStage(wantedStages(conf.stages), value, label)) return;

  const lead = await db.queryOne<{ external_id: string }>(
    `SELECT external_id FROM ipy_lead_inbox
      WHERE record_id = $1 AND source = 'facebook' AND external_id IS NOT NULL
      ORDER BY received_at LIMIT 1`,
    [p.recordId],
  );
  if (!lead) return; // Not a Facebook lead: Meta has nothing to match it to, and we send nothing.

  await deliverStage({
    recordId: p.recordId,
    label,
    leadId: lead.external_id,
    countryCode: p.record.country_code as string | undefined,
    mobile: p.record.mobile as string | undefined,
    email: p.record.email as string | undefined,
    eventSeconds: Math.floor(Date.now() / 1000),
  });
}

interface StageToDeliver {
  recordId: string;
  label: string;
  leadId: string;
  countryCode?: string | null;
  mobile?: string | null;
  email?: string | null;
  eventSeconds: number;
}

/** Claims the (lead, stage), tells Meta once, and records what happened. Returns whether Meta took it. */
async function deliverStage(stage: StageToDeliver): Promise<{ sent: boolean; reason?: string }> {
  const conf = getIntegrationConfig('meta_conversions');
  const token = getIntegrationCredentials('meta_conversions')?.accessToken;
  if (!conf?.datasetId || !token) return { sent: false, reason: 'The card is not filled in.' };
  if (!(await claim(stage.recordId, stage.label, stage.leadId))) return { sent: false, reason: 'Already reported.' };

  try {
    const body = buildConversionBody({
      eventName: stage.label,
      recordId: stage.recordId,
      leadId: stage.leadId,
      countryCode: stage.countryCode,
      mobile: stage.mobile,
      email: stage.email,
      nowSeconds: stage.eventSeconds,
      testEventCode: conf.testEventCode?.trim() || undefined,
    });
    await callMeta('POST', `${conf.datasetId.trim()}/events`, token, body);
    await db.query(`UPDATE ipy_meta_conversion SET status = 'sent', sent_at = now() WHERE record_id = $1 AND event_name = $2`, [stage.recordId, stage.label]);
    return { sent: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ recordId: stage.recordId, stage: stage.label, reason }, 'Meta conversion not delivered');
    await db.query(`UPDATE ipy_meta_conversion SET status = 'failed', error = $3 WHERE record_id = $1 AND event_name = $2`, [stage.recordId, stage.label, reason.slice(0, 500)]);
    return { sent: false, reason };
  }
}

/** Meta refuses an event older than 7 days, and one old event fails the whole request. */
export const WAITING_WINDOW_DAYS = 6;

export interface WaitingChange {
  recordId: string;
  statusValue: string;
  changedAt: Date;
  leadId: string;
  leadReceivedAt: Date;
}

export interface WaitingStage {
  recordId: string;
  label: string;
  leadId: string;
  eventSeconds: number;
}

/**
 * The event time Meta will take: when the status changed, but never before the lead
 * itself existed (Meta discards those) and never in the future.
 */
export function eventSecondsFor(changedAt: Date, leadReceivedAt: Date, now: Date): number {
  const afterTheLead = Math.max(changedAt.getTime(), leadReceivedAt.getTime() + 1000);
  return Math.floor(Math.min(afterTheLead, now.getTime()) / 1000);
}

/** Of the latest status changes, the ones that left a lead on a stage worth reporting. */
export function chooseWaitingStages(
  changes: WaitingChange[],
  options: Parameters<typeof picklistOptionForValue>[0],
  stagesSetting: string | undefined,
  now: Date,
): WaitingStage[] {
  const stages = wantedStages(stagesSetting);
  const chosen: WaitingStage[] = [];
  for (const change of changes) {
    const label = picklistOptionForValue(options, change.statusValue)?.label ?? change.statusValue;
    if (!change.statusValue || !isWantedStage(stages, change.statusValue, label)) continue;
    chosen.push({
      recordId: change.recordId,
      label,
      leadId: change.leadId,
      eventSeconds: eventSecondsFor(change.changedAt, change.leadReceivedAt, now),
    });
  }
  return chosen;
}

async function findWaitingStages(): Promise<WaitingStage[]> {
  const conf = getIntegrationConfig('meta_conversions');
  const module = await getModule('leads');
  const status = module ? statusFieldOf(module.fields) : undefined;
  if (!module || !status) return [];

  // The latest status change of each Facebook lead-ad lead inside the window: where that lead is now.
  const rows = await db.query<{ record_id: string; to_value: string; created_at: Date; external_id: string; received_at: Date }>(
    `SELECT DISTINCT ON (a.record_id)
            a.record_id, c->>'to' AS to_value, a.created_at, i.external_id, i.received_at
       FROM ipy_audit a
       JOIN ipy_record r ON r.id = a.record_id AND r.is_deleted = false
       JOIN ipy_lead_inbox i ON i.record_id = a.record_id AND i.source = 'facebook' AND i.external_id IS NOT NULL
      CROSS JOIN LATERAL jsonb_array_elements(a.changes) c
      WHERE a.module_name = 'leads'
        AND a.created_at > now() - ($2::int * interval '1 day')
        AND c->>'field' = $1
      ORDER BY a.record_id, a.created_at DESC, i.received_at`,
    [status.name, WAITING_WINDOW_DAYS],
  );
  const wanted = chooseWaitingStages(
    rows.rows.map((row) => ({
      recordId: row.record_id,
      statusValue: String(row.to_value ?? ''),
      changedAt: new Date(row.created_at),
      leadId: row.external_id,
      leadReceivedAt: new Date(row.received_at),
    })),
    status.options,
    conf?.stages,
    new Date(),
  );
  if (wanted.length === 0) return [];

  // Leave out what Meta already has; a failed or stuck one stays in so it is retried.
  const done = await db.query<{ record_id: string; event_name: string }>(
    `SELECT record_id, event_name FROM ipy_meta_conversion
      WHERE record_id = ANY($1::uuid[]) AND status = 'sent'`,
    [wanted.map((w) => w.recordId)],
  );
  const sent = new Set(done.rows.map((row) => `${row.record_id}:${row.event_name}`));
  return wanted.filter((w) => !sent.has(`${w.recordId}:${w.label}`));
}

export interface WaitingStagesResult {
  waiting: number;
  byStage: Record<string, number>;
  sent: number;
  failed: { count: number; reasons: string[] };
}

/**
 * Tells Meta about Facebook leads that are already on a reported stage.
 *
 * The live listener only hears about changes made after it was switched on, so
 * leads moved before that were never reported — and Meta's "connect your CRM"
 * recommendation asks for existing events. Two safeguards, both deliberate:
 *  - nothing is sent until the caller repeats the exact count it was shown, so a list
 *    that moved between looking and approving stops rather than surprises;
 *  - it refuses while a Test code is on, because a test event would be recorded as sent
 *    and the real one would then never go.
 */
export async function sendWaitingStages(ctx: ServiceContext, confirm?: number): Promise<WaitingStagesResult> {
  const conf = getIntegrationConfig('meta_conversions');
  const token = getIntegrationCredentials('meta_conversions')?.accessToken;
  if (!conf?.datasetId || !token) throw new BadRequestError('Fill in the Meta Conversions API card first.');
  if (conf.testEventCode?.trim()) throw new BadRequestError('Empty the Test code first: an event sent under it is recorded as sent but never reaches real reporting.');

  const waiting = await findWaitingStages();
  const byStage: Record<string, number> = {};
  for (const w of waiting) byStage[w.label] = (byStage[w.label] ?? 0) + 1;
  const result: WaitingStagesResult = { waiting: waiting.length, byStage, sent: 0, failed: { count: 0, reasons: [] } };
  if (confirm === undefined) return result;
  if (confirm !== waiting.length) throw new BadRequestError(`The list has changed: ${waiting.length} are waiting now, not ${confirm}. Look again before sending.`);

  for (const w of waiting) {
    const record = await getRecord(ctx, 'leads', w.recordId);
    const outcome = await deliverStage({
      recordId: w.recordId,
      label: w.label,
      leadId: w.leadId,
      countryCode: record.values.country_code as string | undefined,
      mobile: record.values.mobile as string | undefined,
      email: record.values.email as string | undefined,
      eventSeconds: w.eventSeconds,
    });
    if (outcome.sent) result.sent += 1;
    else {
      result.failed.count += 1;
      if (outcome.reason && !result.failed.reasons.includes(outcome.reason)) result.failed.reasons.push(outcome.reason);
    }
  }
  return result;
}

export function registerMetaConversions(): void {
  bus.on('record.updated', reportLeadStage);
}
