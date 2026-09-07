/**
 * Telephony.
 *
 * Provider-agnostic click-to-call, inbound routing and call logging.
 * Adapters implement a three-method interface; Twilio and Exotel ship here
 * because they cover most of the Indian real-estate market. With no provider
 * configured everything still logs, so the dialer UI and call timeline work.
 */
import { toE164 } from '@ipropy/shared';
import { config } from '../../config.js';
import { getSettings } from '../../core/settings/integrations.js';
import { isOptedOut } from '../../core/consent/index.js';
import { db, type Tx } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { BadRequestError, IntegrationError } from '../../utils/errors.js';
import { bus } from '../../core/events/bus.js';
import { touchActivity } from '../../core/entity/recordService.js';
import { notify } from '../../core/notifications/index.js';

export interface PlaceCallInput {
  agentUserId: string;
  toNumber: string;
  recordId?: string | null;
  module?: string | null;
  /** override the caller id shown to the customer */
  callerId?: string;
}

export interface CallAdapter {
  name: string;
  /** Connect agent → customer. Most Indian providers dial the agent first. */
  placeCall(input: {
    agentNumber: string;
    customerNumber: string;
    callerId: string;
    callbackUrl: string;
  }): Promise<{ providerCallId: string }>;
  fetchRecording?(providerCallId: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

const twilioAdapter: CallAdapter = {
  name: 'twilio',
  async placeCall({ agentNumber, customerNumber, callerId, callbackUrl }) {
    const { accountSid, authToken } = getSettings().telephony.twilio;
    if (!accountSid || !authToken) throw new IntegrationError('twilio', 'Missing account SID or auth token');

    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`;
    // Dial the agent, then bridge to the customer once they pick up.
    const twiml = `<Response><Dial callerId="${escapeXml(callerId)}" record="record-from-answer-dual" recordingStatusCallback="${escapeXml(callbackUrl)}/recording">${escapeXml(customerNumber)}</Dial></Response>`;

    const body = new URLSearchParams({
      To: agentNumber,
      From: callerId,
      Twiml: twiml,
      StatusCallback: `${callbackUrl}/status`,
      StatusCallbackEvent: 'initiated ringing answered completed',
      StatusCallbackMethod: 'POST',
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });

    const json = await res.json() as { sid?: string; message?: string };
    if (!res.ok || !json.sid) {
      throw new IntegrationError('twilio', json.message ?? `HTTP ${res.status}`);
    }
    return { providerCallId: json.sid };
  },

  async fetchRecording(providerCallId) {
    const { accountSid, authToken } = getSettings().telephony.twilio;
    if (!accountSid || !authToken) return null;
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}/Recordings.json`,
      { headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}` } },
    );
    const json = await res.json() as { recordings?: { uri?: string }[] };
    const uri = json.recordings?.[0]?.uri;
    return uri ? `https://api.twilio.com${uri.replace('.json', '.mp3')}` : null;
  },
};

const exotelAdapter: CallAdapter = {
  name: 'exotel',
  async placeCall({ agentNumber, customerNumber, callerId, callbackUrl }) {
    const { sid, apiKey, apiToken, subdomain } = getSettings().telephony.exotel;
    if (!sid || !apiKey || !apiToken) throw new IntegrationError('exotel', 'Missing Exotel credentials');

    const url = `https://${apiKey}:${apiToken}@${subdomain}/v1/Accounts/${sid}/Calls/connect.json`;
    const body = new URLSearchParams({
      From: agentNumber,        // Exotel dials the agent first
      To: customerNumber,
      CallerId: callerId,
      CallType: 'trans',
      StatusCallback: `${callbackUrl}/status`,
      Record: 'true',
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(20_000),
    });

    const json = await res.json() as { Call?: { Sid?: string }; RestException?: { Message?: string } };
    if (!res.ok || !json.Call?.Sid) {
      throw new IntegrationError('exotel', json.RestException?.Message ?? `HTTP ${res.status}`);
    }
    return { providerCallId: json.Call.Sid };
  },
};

/** No provider configured — log the intent so the UI and timeline still work. */
const nullAdapter: CallAdapter = {
  name: 'none',
  async placeCall({ agentNumber, customerNumber }) {
    logger.info({ agentNumber, customerNumber }, '[telephony:simulated] no provider configured');
    return { providerCallId: `sim_${Date.now()}` };
  },
};

function getAdapter(): CallAdapter {
  switch (getSettings().telephony.provider) {
    case 'twilio': return twilioAdapter;
    case 'exotel': return exotelAdapter;
    default: return nullAdapter;
  }
}

export function isTelephonyConfigured(): boolean {
  return getSettings().telephony.provider !== 'none';
}

// ---------------------------------------------------------------------------
// Click-to-call
// ---------------------------------------------------------------------------

export async function placeCall(input: PlaceCallInput): Promise<{ callId: string; providerCallId: string }> {
  const agent = await db.queryOne<{ phone: string | null; telephony_number: string | null }>(
    `SELECT phone, telephony_number FROM ipy_user WHERE id = $1`, [input.agentUserId],
  );
  const agentNumber = toE164(agent?.telephony_number ?? agent?.phone ?? '');
  if (!agentNumber) {
    throw new BadRequestError('Add a phone number to your profile before using click-to-call');
  }

  const customerNumber = toE164(input.toNumber);
  if (!customerNumber) throw new BadRequestError('The destination number is not valid');

  /*
    Respect Do Not Call before dialling anything.

    This used to read a `do_not_call` column, then — after that column was
    deleted on 11 August — the same value through `to_jsonb`, which is always
    null and therefore always false. The comment called that failing safe "in
    the honest direction". It was not honest, it was fail-open: the gate looked
    present and blocked nobody, and the matching write path was erroring out, so
    a request to stop calling was neither stored nor obeyed.

    It reads the consent store now, which is the same place a WhatsApp STOP
    lands and does not depend on a field an admin can delete. Checked by number
    rather than by record, so a request from someone with no lead still counts.
  */
  if (input.toNumber && await isOptedOut(input.toNumber, 'call')) {
    throw new BadRequestError('This number has asked not to be called.');
  }

  const adapter = getAdapter();
  if (adapter.name === 'none') {
    throw new BadRequestError('No cloud telephony provider is connected. Use the phone dialler instead.');
  }
  const callerId = input.callerId
    ?? getSettings().telephony.twilio.callerId
    ?? getSettings().telephony.exotel.callerId
    ?? agentNumber;

  const callbackUrl = `${config.apiUrl}/api/webhooks/telephony/${adapter.name}`;

  const call = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_call
      (direction, from_number, to_number, user_id, record_id, record_module, status, provider)
     VALUES ('outbound',$1,$2,$3,$4,$5,'queued',$6)
     RETURNING id`,
    [agentNumber, customerNumber, input.agentUserId, input.recordId ?? null, input.module ?? null, adapter.name],
  );

  try {
    const { providerCallId } = await adapter.placeCall({
      agentNumber, customerNumber, callerId, callbackUrl,
    });
    await db.query(`UPDATE ipy_call SET provider_call_id = $2, status = 'ringing' WHERE id = $1`, [call!.id, providerCallId]);

    bus.emitAsync('call.started', {
      callId: call!.id, direction: 'outbound', status: 'ringing',
      recordId: input.recordId ?? null, userId: input.agentUserId,
    });

    return { callId: call!.id, providerCallId };
  } catch (err) {
    await db.query(`UPDATE ipy_call SET status = 'failed' WHERE id = $1`, [call!.id]);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

export interface InboundCallInput {
  from: string;
  to: string;
  providerCallId: string;
  provider: string;
}

export interface InboundRouting {
  callId: string;
  routeToUserId: string | null;
  routeToNumber: string | null;
  recordId: string | null;
  recordLabel: string | null;
  isKnownContact: boolean;
}

/**
 * Decide who should answer an inbound call. Priority: the record owner (so a
 * customer reaches the person who knows them), then the virtual number's
 * configured routing, then anyone in the routed group.
 */
export async function routeInboundCall(input: InboundCallInput): Promise<InboundRouting> {
  const from = toE164(input.from) ?? input.from;
  const tail = from.replace(/\D/g, '').slice(-10);

  const match = await db.queryOne<{ record_id: string; label: string; owner_id: string | null; module_name: string }>(
    `SELECT r.id AS record_id, r.label, r.owner_id, r.module_name
     FROM ipy_e_leads l JOIN ipy_record r ON r.id = l.record_id
     WHERE r.is_deleted = false
       AND (right(regexp_replace(COALESCE(l.mobile,''), '\\D','','g'), 10) = $1
         OR right(regexp_replace(COALESCE(l.alternate_phone,''), '\\D','','g'), 10) = $1)
     ORDER BY CASE l.status WHEN 'Converted' THEN 0 WHEN 'Negotiation' THEN 1 WHEN 'Won' THEN 0 ELSE 2 END
     LIMIT 1`,
    [tail],
  );

  const virtualNumber = await db.queryOne<{
    route_to_user_id: string | null; route_to_group_id: string | null;
    lead_source: string | null;
  }>(
    `SELECT route_to_user_id, route_to_group_id, lead_source
     FROM ipy_virtual_number WHERE number = $1 AND is_active`,
    [toE164(input.to) ?? input.to],
  );

  let routeToUserId = match?.owner_id ?? virtualNumber?.route_to_user_id ?? null;

  // Fall back to the least-busy member of the routed group.
  if (!routeToUserId && virtualNumber?.route_to_group_id) {
    const member = await db.queryOne<{ member_id: string }>(
      `SELECT gm.member_id FROM ipy_group_member gm
       JOIN ipy_user u ON u.id = gm.member_id
       WHERE gm.group_id = $1 AND gm.member_type = 'user' AND u.is_active AND u.deleted_at IS NULL
       ORDER BY (SELECT COUNT(*) FROM ipy_call c WHERE c.user_id = u.id AND c.started_at > now() - interval '1 hour')
       LIMIT 1`,
      [virtualNumber.route_to_group_id],
    );
    routeToUserId = member?.member_id ?? null;
  }

  const call = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_call
      (direction, from_number, to_number, user_id, record_id, record_module, status,
       provider, provider_call_id, virtual_number)
     VALUES ('inbound',$1,$2,$3,$4,$5,'ringing',$6,$7,$2)
     RETURNING id`,
    [
      from, toE164(input.to) ?? input.to, routeToUserId,
      match?.record_id ?? null, match?.module_name ?? null,
      input.provider, input.providerCallId,
    ],
  );

  // Unknown number on a tracked line: create a lead so nothing is lost.
  if (!match && virtualNumber) {
    await createLeadFromCall(from, virtualNumber, call!.id, routeToUserId);
  }

  if (routeToUserId) {
    await notify({
      userId: routeToUserId,
      kind: 'call',
      title: 'Incoming call',
      body: match ? `${match.label} is calling (${from})` : `Unknown number ${from}`,
      link: match ? `/${match.module_name}/${match.record_id}` : '/calls',
      recordId: match?.record_id ?? null,
    });
  }

  const routeTo = routeToUserId
    ? (await db.queryOne<{ phone: string | null; telephony_number: string | null }>(
        `SELECT phone, telephony_number FROM ipy_user WHERE id = $1`, [routeToUserId],
      ))
    : null;

  return {
    callId: call!.id,
    routeToUserId,
    routeToNumber: toE164(routeTo?.telephony_number ?? routeTo?.phone ?? '') ?? null,
    recordId: match?.record_id ?? null,
    recordLabel: match?.label ?? null,
    isKnownContact: Boolean(match),
  };
}

async function createLeadFromCall(
  from: string,
  virtualNumber: { lead_source: string | null },
  callId: string,
  ownerId: string | null,
  conn: Tx = db,
): Promise<void> {
  try {
    const { createRecord } = await import('../../core/entity/recordService.js');
    const systemUser = {
      id: ownerId ?? '00000000-0000-0000-0000-000000000000',
      email: 'system@ipropy', firstName: 'iPropy', lastName: 'Telephony',
      fullName: 'iPropy Telephony', avatarUrl: null, phone: null,
      isAdmin: true, isActive: true, roleId: null, roleName: null,
      profileId: null, profileName: null, groupIds: [],
      timezone: 'Asia/Kolkata', locale: 'en-IN', currency: 'INR',
      theme: 'system' as const, defaultDashboardId: null, lastLoginAt: null,
    };

    const lead = await createRecord(
      { user: systemUser, subordinateIds: [], groupIds: [], system: true, source: 'inbound_call' },
      'leads',
      {
        first_name: 'Inbound',
        last_name: `Caller ${from.slice(-4)}`,
        mobile: from,
        status: 'New',
        lead_source: virtualNumber.lead_source ?? 'Cold Call',
        owner_id: ownerId,
        description: `Auto-created from an inbound call to a tracked number.`,
      },
      { skipDuplicateCheck: false },
    );

    await conn.query(`UPDATE ipy_call SET record_id = $2, record_module = 'leads' WHERE id = $1`, [callId, lead.id]);
  } catch (err) {
    // A duplicate is the expected outcome for a repeat caller — not an error.
    logger.debug({ err, from }, 'inbound-call lead creation skipped');
  }
}

// ---------------------------------------------------------------------------
// Call lifecycle
// ---------------------------------------------------------------------------

export interface CallStatusUpdate {
  providerCallId: string;
  status: string;
  durationSeconds?: number;
  recordingUrl?: string;
  answeredAt?: Date;
  endedAt?: Date;
}

const STATUS_MAP: Record<string, string> = {
  queued: 'queued', initiated: 'queued', ringing: 'ringing', 'in-progress': 'in_progress',
  answered: 'in_progress', completed: 'completed', busy: 'busy', 'no-answer': 'no_answer',
  failed: 'failed', canceled: 'canceled', 'no-answer-agent': 'no_answer',
};

export async function updateCallStatus(update: CallStatusUpdate): Promise<void> {
  const status = STATUS_MAP[update.status] ?? update.status;

  const call = await db.queryOne<{ id: string; record_id: string | null; user_id: string | null; direction: string }>(
    `UPDATE ipy_call
     SET status = $2,
         duration_seconds = COALESCE($3, duration_seconds),
         recording_url = COALESCE($4, recording_url),
         answered_at = COALESCE($5, answered_at),
         ended_at = COALESCE($6, ended_at)
     WHERE provider_call_id = $1
     RETURNING id, record_id, user_id, direction`,
    [
      update.providerCallId, status,
      update.durationSeconds ?? null, update.recordingUrl ?? null,
      update.answeredAt ?? null, update.endedAt ?? null,
    ],
  );
  if (!call) return;

  if (['completed', 'busy', 'no_answer', 'failed', 'canceled'].includes(status)) {
    if (call.record_id) {
      await touchActivity(call.record_id);
      // A completed outbound call counts as contact — keep the lead in step.
      if (status === 'completed' && call.direction === 'outbound') {
        await db.query(
          `UPDATE ipy_e_leads
           SET last_contacted_at = now(), contact_attempts = contact_attempts + 1,
               status = CASE WHEN status = 'New' THEN 'Contacted' ELSE status END
           WHERE record_id = $1`,
          [call.record_id],
        );
        await db.query(
          `UPDATE ipy_sla_tracker SET first_response_at = COALESCE(first_response_at, now())
           WHERE record_id = $1 AND first_response_at IS NULL`,
          [call.record_id],
        );
      } else if (call.direction === 'outbound') {
        await db.query(
          `UPDATE ipy_e_leads SET contact_attempts = contact_attempts + 1 WHERE record_id = $1`,
          [call.record_id],
        );
      }
    }

    bus.emitAsync('call.ended', {
      callId: call.id, direction: call.direction, status,
      recordId: call.record_id, userId: call.user_id,
    });

    // Recordings usually land a few seconds after the call ends.
    if (status === 'completed' && !update.recordingUrl) {
      setTimeout(() => { void backfillRecording(update.providerCallId); }, 15_000).unref?.();
    }
  }
}

async function backfillRecording(providerCallId: string): Promise<void> {
  const adapter = getAdapter();
  if (!adapter.fetchRecording) return;
  try {
    const url = await adapter.fetchRecording(providerCallId);
    if (url) {
      await db.query(`UPDATE ipy_call SET recording_url = $2 WHERE provider_call_id = $1`, [providerCallId, url]);
      const call = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_call WHERE provider_call_id = $1`, [providerCallId]);
      if (call) {
        const { analyseCallRecording } = await import('../../ai/callAnalysis.js');
        void analyseCallRecording(call.id).catch((err) => logger.warn({ err }, 'call analysis failed'));
      }
    }
  } catch (err) {
    logger.warn({ err, providerCallId }, 'recording backfill failed');
  }
}

/** Log a call the agent made outside the system (mobile, desk phone). */
export async function logManualCall(input: {
  userId: string;
  recordId: string | null;
  module: string | null;
  toNumber: string;
  direction: 'inbound' | 'outbound';
  durationSeconds: number;
  disposition?: string;
  notes?: string;
}): Promise<{ callId: string }> {
  const agent = await db.queryOne<{ phone: string | null }>(`SELECT phone FROM ipy_user WHERE id = $1`, [input.userId]);
  // $7 is read twice, so it needs the same deduced type in both places. `$7 || ' seconds'`
  // made it text while duration_seconds made it integer, and Postgres rejected the whole
  // statement with "inconsistent types deduced for parameter $7" — every manual call log
  // returned a 500. make_interval takes the integer directly.
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_call
      (direction, from_number, to_number, user_id, record_id, record_module,
       status, duration_seconds, provider, source, disposition, notes, started_at, ended_at)
     VALUES ($1,$2,$3,$4,$5,$6,'completed',$7::int,'manual','manual',$8,$9,
             now() - make_interval(secs => $7::int), now())
     RETURNING id`,
    [
      input.direction,
      input.direction === 'outbound' ? (agent?.phone ?? 'agent') : input.toNumber,
      input.direction === 'outbound' ? input.toNumber : (agent?.phone ?? 'agent'),
      input.userId, input.recordId, input.module,
      input.durationSeconds, input.disposition ?? null, input.notes ?? null,
    ],
  );

  if (input.recordId) {
    await touchActivity(input.recordId);
    await db.query(
      `UPDATE ipy_e_leads
       SET last_contacted_at = now(), contact_attempts = contact_attempts + 1,
           status = CASE WHEN status = 'New' THEN 'Contacted' ELSE status END
       WHERE record_id = $1`,
      [input.recordId],
    );
  }

  bus.emitAsync('call.ended', {
    callId: row!.id, direction: input.direction, status: 'completed',
    recordId: input.recordId, userId: input.userId,
  });

  return { callId: row!.id };
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] ?? c
  ));
}
