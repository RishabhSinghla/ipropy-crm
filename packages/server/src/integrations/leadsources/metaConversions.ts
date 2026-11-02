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

  if (!(await claim(p.recordId, label, lead.external_id))) return;

  try {
    const body = buildConversionBody({
      eventName: label,
      recordId: p.recordId,
      leadId: lead.external_id,
      countryCode: p.record.country_code as string | undefined,
      mobile: p.record.mobile as string | undefined,
      email: p.record.email as string | undefined,
      nowSeconds: Math.floor(Date.now() / 1000),
      testEventCode: conf.testEventCode?.trim() || undefined,
    });
    await callMeta('POST', `${conf.datasetId.trim()}/events`, token, body);
    await db.query(`UPDATE ipy_meta_conversion SET status = 'sent', sent_at = now() WHERE record_id = $1 AND event_name = $2`, [p.recordId, label]);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ recordId: p.recordId, stage: label, reason }, 'Meta conversion not delivered');
    await db.query(`UPDATE ipy_meta_conversion SET status = 'failed', error = $3 WHERE record_id = $1 AND event_name = $2`, [p.recordId, label, reason.slice(0, 500)]);
  }
}

export function registerMetaConversions(): void {
  bus.on('record.updated', reportLeadStage);
}
