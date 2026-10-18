import { z } from 'zod';
import { toE164 } from '@ipropy/shared';
import { db, transaction } from '../../db/pool.js';
import { config } from '../../config.js';
import { recordService } from '../../core/entity/recordService.js';
import { systemContext } from '../../core/workflow/tasks.js';
import { matchContact } from '../whatsapp/matchContact.js';
import { readSarvamSettings, sarvamFirstName, sarvamWebhookUrl, parseSarvamResult, recordSarvamResult } from './sarvam.js';
import { readSarvamPolicy } from './policy.js';

function inboundAgent(appId?: string) {
  const read = readSarvamSettings();
  if ('missing' in read) return null;
  const policy = readSarvamPolicy();
  const agent = read.settings.agentsByModule[policy.inboundModule];
  const expectedApp = agent?.appId || read.settings.appId;
  if (!expectedApp || (appId && appId !== expectedApp)) return null;
  return { settings: read.settings, policy, appId: expectedApp, version: agent?.appVersion ?? read.settings.appVersion };
}

/** Caller ID is a match hint, not verified identity. Never guess between shared numbers. */
export async function inboundCallerContext(phone: string, appId?: string): Promise<Record<string, unknown> | null> {
  const target = inboundAgent(appId);
  if (!target) return null;
  const { policy } = target;
  const match = await matchContact(policy.inboundModule, phone);
  const neutral = { user_name: '', first_name: '', crm_module: '', crm_record_id: '', lead_phone: phone };
  if (match.kind !== 'one') return { ...neutral, crm_context: JSON.stringify({
    call_direction: 'inbound', match: match.kind, identity_verification_required: true,
    guidance: 'Thank the person for calling iPROPY. Ask their name and how you can help. Do not assume a prior enquiry or disclose any existing customer details.',
  }) };
  const record = await recordService.getRecord(await systemContext(null), policy.inboundModule, match.recordId, { withDisplay: false });
  const previous = await db.query(`SELECT direction,status,started_at,disposition,ai_summary,notes FROM ipy_call
    WHERE record_id=$1 AND record_module=$2 ORDER BY started_at DESC LIMIT 5`, [record.id,policy.inboundModule]);
  const name = String(record.values.full_name ?? record.label ?? '').trim();
  return { user_name: name, first_name: sarvamFirstName(name), crm_module: policy.inboundModule, crm_record_id: record.id, lead_phone: phone,
    crm_context: JSON.stringify({ call_direction: 'inbound', match: 'one', identity_verification_required: true,
      guidance: 'This person called iPROPY. Thank them for calling back. Confirm their name before discussing their saved requirements, appointments or past conversations. Use the CRM context to avoid repeating answered questions. Never claim we placed this inbound call.',
      module: policy.inboundModule, recordId: record.id, fields: record.values, recent_calls: previous.rows }) };
}

const inboundResult = z.object({
  app_id: z.string().min(1), app_version: z.number().int().positive(), deployment_id: z.string().min(1),
  interaction_id: z.string().min(1).max(500), user_phone_number: z.string().min(6), agent_phone_number: z.string().min(6),
  duration: z.number().min(0).max(86400).optional(), start_datetime: z.string().optional().nullable(),
}).passthrough();

export async function recordInboundSarvamCall(body: unknown): Promise<boolean> {
  const parsed = inboundResult.safeParse(body);
  if (!parsed.success) return false;
  const input = parsed.data;
  const target = inboundAgent(input.app_id);
  if (!target || input.deployment_id !== target.policy.inboundDeploymentId) return false;
  const phone = toE164(input.user_phone_number);
  if (!phone) return false;
  const match = await matchContact(target.policy.inboundModule, phone);
  const record = match.kind === 'one'
    ? await recordService.getRecord(await systemContext(null), target.policy.inboundModule, match.recordId, { withDisplay: false }) : null;
  const started = input.start_datetime && Number.isFinite(Date.parse(input.start_datetime)) ? new Date(input.start_datetime) : new Date();
  await transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`sarvam-inbound:${input.interaction_id}`]);
    await tx.query(`INSERT INTO ipy_call(direction,from_number,to_number,status,provider,provider_call_id,source,record_id,record_module,user_id,started_at)
      SELECT 'inbound',$1,$2,'queued','sarvam_voice',$3,'sarvam',$4,$5,$6,$7
      WHERE NOT EXISTS (SELECT 1 FROM ipy_call WHERE provider='sarvam_voice' AND provider_call_id=$3)`,
      [phone,input.agent_phone_number,input.interaction_id,record?.id ?? null,record ? target.policy.inboundModule : null,
        record?.ownerType === 'user' ? record.ownerId : null,started]);
  });
  const result = parseSarvamResult({ ...input, attempt_id: input.interaction_id, status: (input.duration ?? 0) > 0 ? 'connected' : 'failed',
    final_agent_variables: input.final_agent_variables ?? input.output_agent_variables });
  return result ? recordSarvamResult(result) : false;
}

async function providerRequest(path: string, method = 'GET', body?: unknown): Promise<Record<string, unknown>> {
  const read = readSarvamSettings();
  if ('missing' in read) throw new Error(read.missing);
  const s = read.settings;
  const response = await fetch(`https://apps.sarvam.ai/api/app-authoring/v1/orgs/${encodeURIComponent(s.orgId)}/workspaces/${encodeURIComponent(s.workspaceId)}/deployments/${path}`, {
    method, headers: { 'X-API-Key': s.apiKey, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Sarvam inbound request failed (${response.status}). Check this deployment in Sarvam.`);
  return await response.json() as Record<string, unknown>;
}

/** Keep the existing number and schedule; follow the version selected as live in CRM. */
export async function syncSarvamInbound(): Promise<{ enabled: boolean; version?: number; deploymentId?: string; status?: string }> {
  const policy = readSarvamPolicy();
  if (policy.syncInboundVersion !== 'true' || !policy.inboundDeploymentId) return { enabled: false };
  const target = inboundAgent();
  if (!target) throw new Error('Configure the inbound CRM module and agent first.');
  const id = encodeURIComponent(policy.inboundDeploymentId);
  return transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(731904219)');
    const deployment = await providerRequest(id);
    if (deployment.app_id !== target.appId) throw new Error('This deployment belongs to another agent. Its routing was left unchanged.');
    const webhook = `${sarvamWebhookUrl(config.appUrl.split(',')[0]!.trim(),target.settings.webhookSecret)}/inbound`;
    const existingWebhook = deployment.webhook_config as { url?: string; metadata?: unknown } | null;
    const changed = Number(deployment.app_version) !== target.version || existingWebhook?.url !== webhook;
    if (changed) {
      const active = deployment.status === 'active';
      if (active) await providerRequest(`${id}/status`, 'PUT', { action: 'pause' });
      try { await providerRequest(id, 'PATCH', { app_version: target.version, webhook_config: { ...existingWebhook, url: webhook } }); }
      finally { if (active) await providerRequest(`${id}/status`, 'PUT', { action: 'resume' }); }
    }
    const verified = changed ? await providerRequest(id) : deployment;
    if (Number(verified.app_version) !== target.version) throw new Error('Inbound version did not match after saving.');
    if ((verified.webhook_config as { url?: string } | null)?.url !== webhook) throw new Error('Inbound CRM callback URL did not match after saving.');
    if (deployment.status === 'active' && verified.status !== 'active') throw new Error('Inbound deployment did not resume. Check its status in Sarvam.');
    return { enabled: true, version: target.version, deploymentId: policy.inboundDeploymentId, status: String(verified.status ?? 'unknown') };
  });
}
