/**
 * Sarvam Voice Agents — the AI that rings a customer and talks to them.
 *
 * Sarvam runs the whole call (speech in, speech out, the conversation, the
 * phone line). The CRM does two things: asks Sarvam to start a call, and
 * writes down what Sarvam reports when the call ends.
 *
 * Written from Sarvam's published API reference on 16 October 2026. Two facts
 * in it are not documented and are handled on purpose:
 *  - the result webhook carries no signature, so the URL itself holds a secret
 *    (`webhookSecret`) and is checked with a constant-time compare;
 *  - there is no documented read-only "ping", so the connection test lists the
 *    workspace's deployments and says honestly when it could not tell.
 */
import crypto from 'node:crypto';
import { db } from '../../db/pool.js';
import { getIntegrationConfig, getIntegrationCredentials } from '../../core/settings/integrations.js';
import { logger } from '../../utils/logger.js';

export const SARVAM_PROVIDER = 'sarvam_voice';
const SARVAM_HOST = 'https://apps.sarvam.ai';

export interface SarvamSettings {
  apiKey: string;
  orgId: string;
  workspaceId: string;
  appId: string;
  appVersion: number;
  connectionId: string;
  agentPhoneNumber: string;
  webhookSecret: string;
  agentsByModule: Record<string, { label?: string; appId: string; appVersion: number; connectionId?: string; agentPhoneNumber?: string }>;
}

/** The card's values, or the name of the first one still missing. */
export function readSarvamSettings(): { settings: SarvamSettings } | { missing: string } {
  const config = getIntegrationConfig(SARVAM_PROVIDER);
  const secrets = getIntegrationCredentials(SARVAM_PROVIDER);
  if (!config || !secrets) return { missing: 'The Sarvam card is not switched on.' };

  const wanted: [string, string | undefined][] = [
    ['API key', secrets.apiKey],
    ['Webhook secret', secrets.webhookSecret],
    ['Organisation ID', config.orgId],
    ['Workspace ID', config.workspaceId],
  ];
  for (const [label, value] of wanted) {
    if (!value?.trim()) return { missing: `${label} is empty on the Sarvam card.` };
  }
  let agentsByModule: SarvamSettings['agentsByModule'] = {};
  try {
    const parsed = JSON.parse(config.agentsByModule ?? '{}') as Record<string, unknown>;
    for (const [moduleName, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue;
      const agent = value as Record<string, unknown>;
      agentsByModule[moduleName] = {
        label: typeof agent.label === 'string' ? agent.label : undefined,
        appId: typeof agent.appId === 'string' ? agent.appId.trim() : '',
        appVersion: Number(agent.appVersion) > 0 ? Number(agent.appVersion) : 1,
        connectionId: typeof agent.connectionId === 'string' && agent.connectionId.trim() ? agent.connectionId.trim() : undefined,
        agentPhoneNumber: typeof agent.agentPhoneNumber === 'string' && agent.agentPhoneNumber.trim() ? agent.agentPhoneNumber.trim() : undefined,
      };
    }
  } catch {
    return { missing: 'Module agent mapping is invalid JSON on the Sarvam card.' };
  }
  return {
    settings: {
      apiKey: secrets.apiKey!.trim(),
      webhookSecret: secrets.webhookSecret!.trim(),
      orgId: config.orgId!.trim(),
      workspaceId: config.workspaceId!.trim(),
      appId: config.appId?.trim() ?? '',
      appVersion: Number(config.appVersion) > 0 ? Number(config.appVersion) : 1,
      connectionId: config.connectionId?.trim() ?? '',
      agentPhoneNumber: config.agentPhoneNumber?.trim() ?? '',
      agentsByModule,
    },
  };
}

function workspacePath(s: SarvamSettings, service: string, tail: string): string {
  return `${SARVAM_HOST}/api/${service}/v1/orgs/${encodeURIComponent(s.orgId)}`
    + `/workspaces/${encodeURIComponent(s.workspaceId)}/${tail}`;
}

/** Lists the workspace's deployments: proves the key, org and workspace agree. */
export async function testSarvamConnection(): Promise<{ ok: boolean; message: string }> {
  const read = readSarvamSettings();
  if ('missing' in read) return { ok: false, message: read.missing };
  const { settings } = read;
  try {
    const res = await fetch(workspacePath(settings, 'app-authoring', 'deployments'), {
      headers: { 'X-API-Key': settings.apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return { ok: true, message: 'Connected — Sarvam accepted the key for this workspace.' };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: 'Sarvam refused the API key for this organisation and workspace.' };
    }
    return {
      ok: false,
      message: `Could not tell — Sarvam answered ${res.status} to the check. The key may still be fine; `
        + 'press "Call my phone" to prove it for real.',
    };
  } catch (err) {
    return { ok: false, message: `Could not reach Sarvam: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** The address Sarvam posts the finished call to. */
export function sarvamWebhookUrl(publicBaseUrl: string, webhookSecret: string): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}/api/webhooks/sarvam/${encodeURIComponent(webhookSecret)}`;
}

/** Constant-time, so the secret cannot be guessed one character at a time. */
export function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Asks Sarvam to ring one number. Writes the `ipy_call` row first so the
 * result has somewhere to land; the row is keyed by Sarvam's `attempt_id`.
 */
export async function placeAgentCall(input: {
  toNumber: string;
  publicBaseUrl: string;
  recordId?: string | null;
  recordModule?: string | null;
  userId?: string | null;
}): Promise<{ ok: true; attemptId: string } | { ok: false; message: string }> {
  const read = readSarvamSettings();
  if ('missing' in read) return { ok: false, message: read.missing };
  const { settings } = read;
  const mapped = input.recordModule ? settings.agentsByModule[input.recordModule] : undefined;
  if (input.recordModule && Object.keys(settings.agentsByModule).length && !mapped) {
    return { ok: false, message: `No Sarvam agent is configured for the ${input.recordModule} module. Add one under Admin → Integrations → Sarvam.` };
  }
  const appId = mapped?.appId?.trim() || settings.appId;
  const appVersion = mapped?.appVersion ?? settings.appVersion;
  const connectionId = mapped?.connectionId?.trim() || settings.connectionId;
  const agentPhoneNumber = mapped?.agentPhoneNumber?.trim() || settings.agentPhoneNumber;
  if (!appId) return { ok: false, message: `No Sarvam agent is configured for the ${input.recordModule ?? 'default'} module.` };
  if (!connectionId || !agentPhoneNumber) return { ok: false, message: 'Add a telephony connection ID and agent phone number to the Sarvam configuration.' };

  const body = {
    app_config: {
      app_id: appId,
      app_version: appVersion,
      connection_config: {
        connection_id: connectionId,
        agent_phone_number: agentPhoneNumber,
      },
    },
    user_config: { user_phone_number: input.toNumber },
    webhook_config: { url: sarvamWebhookUrl(input.publicBaseUrl, settings.webhookSecret) },
  };

  let res: Response;
  try {
    res = await fetch(workspacePath(settings, 'outbounds', 'outbounds'), {
      method: 'POST',
      headers: { 'X-API-Key': settings.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return { ok: false, message: `Could not reach Sarvam: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    logger.warn({ status: res.status, detail }, 'sarvam refused an outbound call');
    return { ok: false, message: `Sarvam refused the call (${res.status}): ${detail}` };
  }
  const answer = await res.json() as { attempt_id?: string };
  if (!answer.attempt_id) return { ok: false, message: 'Sarvam accepted the call but returned no attempt id.' };

  await db.query(
    `INSERT INTO ipy_call (direction, from_number, to_number, status, provider, provider_call_id,
                           source, record_id, record_module, user_id)
     VALUES ('outbound', $1, $2, 'queued', $3, $4, 'sarvam', $5, $6, $7)`,
    [agentPhoneNumber, input.toNumber, SARVAM_PROVIDER, answer.attempt_id,
      input.recordId ?? null, input.recordModule ?? null, input.userId ?? null],
  );
  return { ok: true, attemptId: answer.attempt_id };
}

export interface SarvamResult {
  attemptId: string;
  status: 'connected' | 'no_answer' | 'busy' | 'failed';
  durationSeconds: number;
  failureReason: string | null;
  transcript: string | null;
}

const STATUSES = new Set(['connected', 'no_answer', 'busy', 'failed']);

/** Reads Sarvam's webhook body; null when it is not one we understand. */
export function parseSarvamResult(body: unknown): SarvamResult | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.attempt_id !== 'string' || typeof b.status !== 'string' || !STATUSES.has(b.status)) return null;

  const turns = Array.isArray(b.interaction_transcript) ? b.interaction_transcript : [];
  const lines = turns.flatMap((t) => {
    const turn = t as { role?: unknown; en_text?: unknown };
    if (typeof turn.en_text !== 'string') return [];
    return [`${turn.role === 'agent' ? 'AI agent' : 'Customer'}: ${turn.en_text}`];
  });
  return {
    attemptId: b.attempt_id,
    status: b.status as SarvamResult['status'],
    durationSeconds: typeof b.duration === 'number' ? Math.round(b.duration) : 0,
    failureReason: typeof b.failure_reason === 'string' ? b.failure_reason : null,
    transcript: lines.length ? lines.join('\n') : null,
  };
}

/** Writes a finished call onto the row placeAgentCall made. */
export async function recordSarvamResult(result: SarvamResult): Promise<boolean> {
  // Sarvam calls an answered conversation `connected`; the CRM's call deck uses
  // `completed` for that terminal state.
  const callStatus = result.status === 'connected' ? 'completed' : result.status;
  const row = await db.query(
    `UPDATE ipy_call
        SET status = $2, duration_seconds = $3, transcript = $4,
            notes = COALESCE($5, notes), ended_at = now()
      WHERE provider = $6 AND provider_call_id = $1`,
    [result.attemptId, callStatus, result.durationSeconds, result.transcript,
      result.failureReason, SARVAM_PROVIDER],
  );
  return (row.rowCount ?? 0) > 0;
}
