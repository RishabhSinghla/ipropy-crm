import { isOptedOut } from '../../core/consent/index.js';
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
import { activeValues } from '../../core/metadata/picklists.js';

export const SARVAM_PROVIDER = 'sarvam_voice';
const SARVAM_HOST = 'https://apps.sarvam.ai';
const SARVAM_ACTOR_ID = '00000000-0000-0000-0000-000000000001';
const SARVAM_ACTOR_EMAIL = 'sarvam-ai@ipropy.local';

export interface SarvamSettings {
  apiKey: string;
  orgId: string;
  workspaceId: string;
  appId: string;
  appVersion: number;
  connectionId: string;
  agentPhoneNumber: string;
  webhookSecret: string;
  agentsByModule: Record<string, {
    label?: string;
    appId: string;
    appVersion: number;
    connectionId?: string;
    agentPhoneNumber?: string;
    fieldMap?: Record<string, string>;
  }>;
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
        appVersion: Number.isInteger(Number(agent.appVersion)) && Number(agent.appVersion) > 0 ? Number(agent.appVersion) : 1,
        connectionId: typeof agent.connectionId === 'string' && agent.connectionId.trim() ? agent.connectionId.trim() : undefined,
        agentPhoneNumber: typeof agent.agentPhoneNumber === 'string' && agent.agentPhoneNumber.trim() ? agent.agentPhoneNumber.trim() : undefined,
        fieldMap: agent.fieldMap && typeof agent.fieldMap === 'object' && !Array.isArray(agent.fieldMap)
          ? Object.fromEntries(Object.entries(agent.fieldMap as Record<string, unknown>)
            .filter(([source, target]) => source.trim() && typeof target === 'string' && target.trim())
            .map(([source, target]) => [source.trim(), (target as string).trim()]))
          : undefined,
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
      appVersion: Number.isInteger(Number(config.appVersion)) && Number(config.appVersion) > 0 ? Number(config.appVersion) : 1,
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

/**
 * Resolve the CRM record for a just-started outbound call. Sarvam calls this
 * from an agent on-start HTTP tool with the destination phone number. The
 * pending call row is the link between that number and the exact CRM record
 * the rep selected, so duplicate phone numbers in different modules are not
 * guessed across the database.
 */
export async function sarvamCallContext(phoneNumber: string, appId?: string, appVersion?: number): Promise<Record<string, unknown> | null> {
  const digits = phoneNumber.replace(/\D/g, '').slice(-10);
  if (digits.length !== 10) return null;

  const pending = await db.query<{ record_id: string; record_module: string }>(
    `SELECT record_id, record_module
       FROM ipy_call
      WHERE provider = $1
        AND direction = 'outbound'
        AND status = 'queued'
        AND record_id IS NOT NULL
        AND record_module IS NOT NULL
        AND created_at > now() - interval '10 minutes'
        AND right(regexp_replace(to_number, '\\D', '', 'g'), 10) = $2
      ORDER BY created_at DESC
      LIMIT 20`,
    [SARVAM_PROVIDER, digits],
  );
  const read = readSarvamSettings();
  if ('missing' in read) return null;
  const matchingCalls = pending.rows.filter((candidate) => {
    const mapped = read.settings.agentsByModule[candidate.record_module];
    if (appId && (mapped?.appId?.trim() || read.settings.appId) !== appId) return false;
    if (appVersion && (mapped?.appVersion ?? read.settings.appVersion) !== appVersion) return false;
    return true;
  });
  // A phone can be shared by several CRM records. Never guess which record
  // the agent should receive when more than one matching call is in flight.
  const candidateRecords = new Set(matchingCalls.map((candidate) => `${candidate.record_module}:${candidate.record_id}`));
  if (candidateRecords.size > 1) return null;
  const call = matchingCalls[0];
  if (!call) return null;

  const [{ recordService }, { systemContext }] = await Promise.all([
    import('../../core/entity/recordService.js'),
    import('../../core/workflow/tasks.js'),
  ]);
  const record = await recordService.getRecord(
    await systemContext(null), call.record_module, call.record_id, { withDisplay: false },
  );
  const values = record.values ?? {};
  const userName = String(values.full_name ?? values.name ?? record.label ?? '').trim();
  const firstName = sarvamFirstName(userName);
  return {
    user_name: userName,
    first_name: firstName,
    crm_context: JSON.stringify({ module: call.record_module, recordId: call.record_id, fields: values }),
    crm_module: call.record_module,
    crm_record_id: call.record_id,
    lead_phone: phoneNumber,
  };
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
}): Promise<{ ok: true; attemptId: string } | { ok: false; message: string; uncertain?: boolean }> {
  const read = readSarvamSettings();
  if ('missing' in read) return { ok: false, message: read.missing };
  const { settings } = read;
  if (await isOptedOut(input.toNumber, 'call')) return { ok: false, message: 'This number has requested no further calls.' };
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
    return { ok: false, uncertain: true, message: `Could not reach Sarvam: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    logger.warn({ status: res.status, detail }, 'sarvam refused an outbound call');
    return { ok: false, uncertain: res.status >= 500, message: `Sarvam refused the call (${res.status}): ${detail}` };
  }
  const answer = await res.json() as { attempt_id?: string };
  if (!answer.attempt_id) return { ok: false, uncertain: true, message: 'Sarvam accepted the call but returned no attempt id.' };

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
  finalAgentVariables: Record<string, unknown> | null;
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
  const finalVariables = b.final_agent_variables;
  return {
    attemptId: b.attempt_id,
    status: b.status as SarvamResult['status'],
    durationSeconds: typeof b.duration === 'number' ? Math.round(b.duration) : 0,
    failureReason: typeof b.failure_reason === 'string' ? b.failure_reason : null,
    transcript: lines.length ? lines.join('\n') : null,
    finalAgentVariables: finalVariables && typeof finalVariables === 'object' && !Array.isArray(finalVariables)
      ? finalVariables as Record<string, unknown>
      : null,
  };
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizedOption(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
}

function scalar(value: unknown): string | number | boolean | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return null;
}

/** Match AI wording to the CRM's current editable disposition options. */
export function sarvamDispositionValue(raw: unknown, options: string[]): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const normalized = normalizedOption(raw);
  const aliases: Record<string, string> = {
    noanswer: 'notreachable',
    notpicked: 'notreachable',
    notpickedup: 'notreachable',
    callback: 'callbacklater',
    callmeback: 'callbacklater',
    visitfixed: 'sitevisitscheduled',
    purchasedelsewhere: 'alreadypurchased',
  };
  const wanted = aliases[normalized] ?? normalized;
  return options.find((option) => normalizedOption(option) === wanted) ?? null;
}

/** An inactive CRM service identity for AI-authored updates and notes. */
async function sarvamSystemContext() {
  const { systemContext } = await import('../../core/workflow/tasks.js');
  const ctx = await systemContext(null);
  await db.query(
    `INSERT INTO ipy_user (id, email, first_name, last_name, is_admin, is_active, accepts_leads, password_hash)
     VALUES ($1, $2, 'Sarvam', 'AI', false, false, false, NULL)
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name, is_admin = false, is_active = false, accepts_leads = false,
       password_hash = NULL, updated_at = now()`,
    [SARVAM_ACTOR_ID, SARVAM_ACTOR_EMAIL],
  );
  ctx.user = {
    ...ctx.user,
    id: SARVAM_ACTOR_ID,
    email: SARVAM_ACTOR_EMAIL,
    firstName: 'Sarvam',
    lastName: 'AI',
    fullName: 'Sarvam AI',
    isAdmin: false,
    isActive: false,
  };
  ctx.source = 'sarvam_ai';
  return ctx;
}

function fieldOption(field: { options?: { value: string; label?: string }[] }, raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const needle = normalizedOption(raw);
  return field.options?.find((option) => normalizedOption(option.value) === needle
    || normalizedOption(option.label ?? '') === needle
    || (needle === 'lost' && normalizedOption(option.value).includes('lost')))?.value ?? null;
}

export function sarvamFirstName(fullName: unknown): string {
  return typeof fullName === 'string' ? fullName.trim().split(/\s+/).filter(Boolean)[0] ?? '' : '';
}

/** Convert clear English visit slots to a CRM date in the business timezone. */
export function sarvamVisitSlotValue(raw: string, uitype: string): string | null {
  const text = raw.trim();
  const parsed = new Date(text);
  if (/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(text) && Number.isFinite(parsed.getTime())) {
    return uitype === 'date' ? text.slice(0, 10) : parsed.toISOString();
  }
  const match = text.match(/^(today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!match) return null;
  const nowParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes): string => nowParts.find((item) => item.type === type)?.value ?? '';
  const year = Number(part('year'));
  const month = Number(part('month'));
  const dateOfMonth = Number(part('day'));
  const phrase = match[1].toLowerCase();
  let dayOffset = phrase === 'tomorrow' ? 1 : 0;
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const requestedWeekday = weekdays.indexOf(phrase);
  if (requestedWeekday >= 0) {
    const today = new Date(Date.UTC(year, month - 1, dateOfMonth));
    dayOffset = (requestedWeekday - today.getUTCDay() + 7) % 7;
    const requestedHour = Number(match[2]) % 12 + (match[4].toLowerCase() === 'pm' ? 12 : 0);
    const requestedMinute = Number(match[3] ?? '00');
    if (dayOffset === 0 && (requestedHour < Number(part('hour'))
      || (requestedHour === Number(part('hour')) && requestedMinute <= Number(part('minute'))))) dayOffset = 7;
  }
  const day = new Date(Date.UTC(year, month - 1, dateOfMonth + dayOffset));
  let hour = Number(match[2]) % 12;
  if (match[4].toLowerCase() === 'pm') hour += 12;
  const date = `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, '0')}-${String(day.getUTCDate()).padStart(2, '0')}`;
  const time = `${String(hour).padStart(2, '0')}:${match[3] ?? '00'}:00`;
  return uitype === 'date' ? date : `${date}T${time}+05:30`;
}

/**
 * Save every extracted value in the record's notes and requirement JSON, then
 * copy values into compatible CRM fields when the module has one. Unknown
 * values stay visible in the feedback block instead of being discarded.
 */
async function syncSarvamFeedbackToRecord(input: {
  recordId: string;
  moduleName: string;
  attemptId: string;
  variables: Record<string, unknown>;
  callStatus: SarvamResult['status'];
}): Promise<void> {
  const [{ recordService }, { registry }, { parseBudget }] = await Promise.all([
    import('../../core/entity/recordService.js'),
    import('../../core/metadata/registry.js'),
    import('../leadsources/parseBudget.js'),
  ]);
  const ctx = await sarvamSystemContext();
  const module = await registry.requireModule(input.moduleName);
  const record = await recordService.getRecord(ctx, module.name, input.recordId, { withDisplay: false });
  const fields = new Map(module.fields.filter((field) => field.isActive).map((field) => [field.name, field]));
  const patch: Record<string, unknown> = {};
  const visitSlot = scalar(input.variables.site_visit_slot);
  let confirmedVisitAt: string | null = null;
  const followUpSlot = scalar(input.variables.follow_up_at
    ?? input.variables.callback_at ?? input.variables.next_follow_up_at
    ?? input.variables.next_followup_at ?? input.variables.follow_up_datetime);
  let confirmedFollowUpAt: string | null = null;
  if (typeof followUpSlot === 'string') confirmedFollowUpAt = sarvamVisitSlotValue(followUpSlot, 'datetime');

  const aliases: Record<string, string> = {
    user_name: 'full_name',
    lead_name: 'full_name',
    call_summary: 'description',
    budget_range: 'budget',
    bhk_preference: 'configuration',
    preferred_area: 'preferred_locations',
    floor_preference: 'floor',
    demand_unit: 'price_unit',
    purchase_timeline: 'possession_timeline',
    purchase_intent: 'purpose',
    site_visit_slot: 'visit_planned_date',
  };
  const configuredFieldMap = readSarvamSettings();
  const moduleFieldMap = !('missing' in configuredFieldMap)
    ? configuredFieldMap.settings.agentsByModule[input.moduleName]?.fieldMap ?? {}
    : {};
  for (const [key, raw] of Object.entries(input.variables)) {
    if (['call_disposition', 'disposition', 'lead_status', 'crm_status', 'lost_reason',
      'follow_up_at', 'callback_at', 'next_follow_up_at', 'next_followup_at', 'follow_up_datetime'].includes(key.toLowerCase())) continue;
    const sourceValues = Array.isArray(raw)
      ? raw.map(scalar).filter((value): value is string | number | boolean => value !== null)
      : [];
    const candidate = scalar(raw) ?? (sourceValues.length ? sourceValues.join(', ') : null);
    if (candidate === null) continue;
    const fieldName = moduleFieldMap[key] ?? aliases[key] ?? key;
    const field = fields.get(fieldName);
    if (!field || field.isReadonly || field.displayType === 'readonly' || fieldName === 'description' || fieldName === 'requirement') continue;

    if (field.uitype === 'picklist' || field.uitype === 'multipicklist') {
      const picklistValues = sourceValues.length ? sourceValues : [candidate];
      const matched = picklistValues.flatMap((value) => {
        const original = String(value);
        const normalized = normalizedOption(original);
        const aliases: Record<string, string> = {
          invest: 'investment',
          'self use': 'buy',
          'self-use': 'buy',
          'home loan': 'home loan',
        };
        const needle = normalizedOption(aliases[original.trim().toLowerCase()] ?? original);
        const option = field.options?.find((entry) => normalizedOption(entry.value) === needle || normalizedOption(entry.label) === needle);
        return option ? [option.value] : [];
      });
      if (!matched.length) continue;
      patch[fieldName] = field.uitype === 'multipicklist' ? matched : matched[0];
      continue;
    }

    if (field.uitype === 'boolean') {
      const value = typeof raw === 'boolean' ? raw : /^(true|yes|1)$/i.test(String(raw));
      // A model saying false must not erase an existing do-not-call choice.
      if (fieldName === 'do_not_call' && !value) continue;
      patch[fieldName] = value;
      continue;
    }

    if (fieldName === 'budget' && typeof candidate === 'string') {
      const amount = parseBudget(candidate);
      if (amount !== undefined) patch[fieldName] = amount;
      continue;
    }

    if ((fieldName === 'visit_planned_date' || key === 'site_visit_slot')
      && (field.uitype === 'date' || field.uitype === 'datetime') && typeof candidate === 'string') {
      const value = sarvamVisitSlotValue(candidate, field.uitype);
      if (value) {
        patch[fieldName] = value;
        confirmedVisitAt = value;
      }
      continue;
    }

    if (field.uitype === 'integer' || field.uitype === 'decimal' || field.uitype === 'currency') {
      const amount = typeof candidate === 'number' ? candidate : Number(String(candidate).replace(/[^\d.-]/g, ''));
      if (Number.isFinite(amount)) patch[fieldName] = amount;
      continue;
    }

    if (field.uitype === 'textarea' || field.uitype === 'string' || field.uitype === 'phone' || field.uitype === 'richtext') {
      patch[fieldName] = candidate;
    }
  }

  // Status, disposition and loss reason are separate facts. Only update a
  // stage from a dedicated Sarvam output variable; never infer Lost from a
  // conversational phrase without a valid reason in this module's dropdown.
  const statusField = module.fields.find((field) => field.isActive
    && (field.columnName === 'status' || field.name === 'status'));
  const lossField = module.fields.find((field) => field.isActive
    && field.displayType !== 'hidden'
    && (field.config?.picklist === 'lost_reason' || field.name === 'lost_reason'));
  const requestedStatus = scalar(input.variables.lead_status ?? input.variables.crm_status);
  const requestedLostReason = scalar(input.variables.lost_reason);
  const matchedStatus = statusField ? fieldOption(statusField, requestedStatus) : null;
  const matchedLostReason = lossField ? fieldOption(lossField, requestedLostReason) : null;
  const isLostRequest = typeof matchedStatus === 'string' && /\blost\b/i.test(matchedStatus);
  const recordAlreadyLost = statusField && /\blost\b/i.test(String(record.values[statusField.name] ?? ''));
  if (statusField && ((matchedStatus && isLostRequest) || recordAlreadyLost) && matchedLostReason) {
    patch[lossField!.name] = matchedLostReason;
    if (matchedStatus && isLostRequest) patch[statusField.name] = matchedStatus;
  } else if (statusField && matchedStatus && isLostRequest) {
    const existingReason = typeof record.values[lossField?.name ?? ''] === 'string'
      ? String(record.values[lossField?.name ?? '']).trim() : '';
    if (lossField && (matchedLostReason || fieldOption(lossField, existingReason))) {
      patch[lossField.name] = matchedLostReason ?? fieldOption(lossField, existingReason);
      patch[statusField.name] = matchedStatus;
    }
  } else if (statusField && matchedStatus) {
    patch[statusField.name] = matchedStatus;
  } else if (statusField && input.moduleName === 'leads'
    && input.callStatus === 'connected'
    && ['new', 'attemptedcontact'].includes(normalizedOption(String(record.values[statusField.name] ?? '')))) {
    // A real conversation moves a brand-new lead to Contacted, but never
    // downgrades a qualified or later-stage lead.
    const contacted = fieldOption(statusField, 'Contacted');
    if (contacted) patch[statusField.name] = contacted;
  }
  if (!matchedStatus && requestedStatus) {
    logger.warn({ recordId: input.recordId, requestedStatus }, 'Sarvam returned a lead status missing from this CRM module');
  }
  if ((isLostRequest || recordAlreadyLost) && !matchedLostReason && !fieldOption(lossField ?? {}, typeof record.values[lossField?.name ?? ''] === 'string' ? record.values[lossField?.name ?? ''] : '')) {
    logger.warn({ recordId: input.recordId }, 'Sarvam marked a record lost without a valid CRM lost reason; status was left unchanged');
  }

  const existingRequirement = plainObject(record.values.requirement) ?? {};
  if (fields.has('requirement')) {
    patch.requirement = {
      ...existingRequirement,
      sarvam_ai_call: {
        attempt_id: input.attemptId,
        captured_at: new Date().toISOString(),
        variables: input.variables,
      },
    };
  }

  const marker = `[AI call ${input.attemptId}]`;
  const feedback = Object.entries(input.variables)
    .filter(([key]) => !['crm_context', 'crm_module', 'crm_record_id'].includes(key.toLowerCase()))
    .map(([key, value]) => {
      const valueText = typeof value === 'string' ? value.trim() : JSON.stringify(value);
      return valueText ? `${key.replace(/_/g, ' ')}: ${valueText}` : null;
    })
    .filter((line): line is string => Boolean(line));
  const commentBody = ['Sarvam AI call feedback', ...feedback].join('\n').slice(0, 10_000);
  await db.query(
    `INSERT INTO ipy_comment (record_id, user_id, body, source_external_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (source_external_id) DO NOTHING`,
    [input.recordId, ctx.user.id, commentBody, `sarvam_ai_call:${input.attemptId}`],
  );
  await recordService.touchActivity(input.recordId);

  const existingNotes = typeof record.values.description === 'string' ? record.values.description.trim() : '';
  if (!existingNotes.includes(marker) && fields.has('description')) {
    patch.description = [existingNotes, marker, ...feedback].filter(Boolean).join('\n');
  }

  if (Object.keys(patch).length) {
    await recordService.updateRecord(ctx, module.name, input.recordId, patch, { skipWorkflow: true });
  }
  if (confirmedVisitAt && visitSlot) {
    const visitDate = new Date(confirmedVisitAt);
    if (Number.isFinite(visitDate.getTime())) {
      const { scheduleFollowUp } = await import('../../core/workflow/followUp.js');
      await scheduleFollowUp({
        recordId: input.recordId,
        module: module.name,
        on: visitDate,
        reason: 'Site visit confirmed by Sarvam AI',
        notes: typeof visitSlot === 'string' ? visitSlot : null,
        ownerId: record.ownerId ?? null,
        authorId: ctx.user.id,
      });
    }
  } else if (confirmedFollowUpAt && followUpSlot) {
    const followUpDate = new Date(confirmedFollowUpAt);
    if (Number.isFinite(followUpDate.getTime())) {
      const { scheduleFollowUp } = await import('../../core/workflow/followUp.js');
      await scheduleFollowUp({
        recordId: input.recordId,
        module: module.name,
        on: followUpDate,
        reason: 'Call-back scheduled by Sarvam AI',
        notes: typeof followUpSlot === 'string' ? followUpSlot : null,
        ownerId: record.ownerId ?? null,
        authorId: ctx.user.id,
      });
    }
  }
}

/** Writes a finished call onto the row placeAgentCall made. */
export async function recordSarvamResult(result: SarvamResult): Promise<boolean> {
  // Sarvam calls an answered conversation `connected`; the CRM's call deck uses
  // `completed` for that terminal state.
  const callStatus = result.status === 'connected' ? 'completed' : result.status;
  const dispositionOptions = await activeValues('call_disposition');
  const suppliedDisposition = result.finalAgentVariables?.call_disposition
    ?? result.finalAgentVariables?.disposition;
  const disposition = sarvamDispositionValue(suppliedDisposition, dispositionOptions)
    ?? (result.status === 'busy' ? sarvamDispositionValue('Busy', dispositionOptions)
      : result.status === 'no_answer' ? sarvamDispositionValue('Not Reachable', dispositionOptions) : null);
  const row = await db.query(
    `UPDATE ipy_call
        SET status = $2, duration_seconds = $3, transcript = $4,
            notes = COALESCE($5, notes), ended_at = now(),
            disposition = COALESCE($7, disposition),
            disposition_at = CASE WHEN $7 IS NULL THEN disposition_at ELSE now() END
      WHERE provider = $6 AND provider_call_id = $1 AND status = 'queued'`,
    [result.attemptId, callStatus, result.durationSeconds, result.transcript,
      result.failureReason, SARVAM_PROVIDER, disposition],
  );
  if (!(row.rowCount ?? 0)) return false;

  const linked = await db.queryOne<{ record_id: string | null; record_module: string | null }>(
    `SELECT record_id, record_module FROM ipy_call
      WHERE provider = $1 AND provider_call_id = $2`,
    [SARVAM_PROVIDER, result.attemptId],
  );
  if (linked?.record_id && linked.record_module && result.finalAgentVariables) {
    try {
      await syncSarvamFeedbackToRecord({
        recordId: linked.record_id,
        moduleName: linked.record_module,
        attemptId: result.attemptId,
        variables: result.finalAgentVariables,
        callStatus: result.status,
      });
    } catch (err) {
      logger.error({ attemptId: result.attemptId, err }, 'sarvam call feedback could not be synced to its CRM record');
      // Let Sarvam retry the callback; the feedback comment itself is
      // idempotent by attempt ID, so an already-written note is not duplicated.
      await db.query(
        `UPDATE ipy_call SET status = 'queued', ended_at = NULL
          WHERE provider = $1 AND provider_call_id = $2`,
        [SARVAM_PROVIDER, result.attemptId],
      );
      throw err;
    }
  }
  return true;
}
