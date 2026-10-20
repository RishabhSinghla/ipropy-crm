/**
 * Sarvam's analytics API: the record of every attempt and conversation, whether or not the CRM heard about it.
 *
 * Verified against docs.sarvam.ai/voice-agents/api/analytics on 20 October 2026. Two facts shape everything here:
 *  - results reach the CRM by webhook, and Sarvam signs nothing and retries only so long, so a lost delivery
 *    left a call "queued" for ever (the queue marks it `unknown` after 15 minutes and stops dialling);
 *  - a campaign started in Sarvam's own dashboard never touched the CRM at all.
 * Reading the attempts back closes both. Responses carry the customer's full phone number: they are read, used to
 * find the CRM record, and not logged.
 */
import { logger } from '../../utils/logger.js';
import { readSarvamSettings, type SarvamSettings } from './sarvam.js';

const ANALYTICS = 'https://apps.sarvam.ai/api/analytics/v1';

export interface SarvamAttempt {
  attempt_id?: string | null;
  interaction_id?: string | null;
  user_contact?: string | null;
  connectivity_status?: string | null;
  failure_reason?: string | null;
  duration_in_seconds?: number | null;
  start_datetime?: string | null;
  attempted_at?: string | null;
  channel_direction?: string | null;
  campaign_id?: string | null;
  is_debug_call?: number | null;
  agent_variables?: Record<string, unknown> | null;
}

export interface SarvamInteraction extends SarvamAttempt {
  job_id?: string | null;
  translate_transcript?: Array<{ role: string; text: string }>;
  original_transcript?: Array<{ role: string; text: string }>;
  ended_by?: string | null;
  language_name?: string | null;
}

function scope(settings: SarvamSettings, appId: string, tail: string): string {
  return `${ANALYTICS}/${encodeURIComponent(settings.orgId)}/${encodeURIComponent(settings.workspaceId)}/${encodeURIComponent(appId)}/${tail}`;
}

/** Sarvam wants an offset on the range, and a `+` in it must be encoded. */
function range(from: Date, to: Date): string {
  return `start_datetime=${encodeURIComponent(from.toISOString())}&end_datetime=${encodeURIComponent(to.toISOString())}`;
}

/** One page after another until Sarvam says there is no next, with a ceiling so a runaway cannot loop for ever. */
async function pages<T>(settings: SarvamSettings, appId: string, tail: string, query: string, ceiling = 20): Promise<T[]> {
  const out: T[] = [];
  let next = `?${query}&limit=500&offset=0`;
  for (let page = 0; page < ceiling && next; page += 1) {
    const res = await fetch(`${scope(settings, appId, tail)}${next}`, { headers: { 'X-API-Key': settings.apiKey }, signal: AbortSignal.timeout(30_000) });
    if (res.status === 429) {
      logger.warn({ retryAfter: res.headers.get('Retry-After') }, 'sarvam analytics rate limit; stopping this pass');
      break;
    }
    if (!res.ok) throw new Error(`Sarvam analytics answered ${res.status} for ${tail}`);
    const body = await res.json() as { items?: T[]; next_page_uri?: string };
    out.push(...(body.items ?? []));
    next = body.next_page_uri ?? '';
  }
  return out;
}

export function listAttempts(settings: SarvamSettings, appId: string, from: Date, to: Date): Promise<SarvamAttempt[]> {
  return pages<SarvamAttempt>(settings, appId, 'attempts', range(from, to));
}

/** With the English transcript inline: what a call said, without a request per call. */
export function listInteractions(settings: SarvamSettings, appId: string, from: Date, to: Date): Promise<SarvamInteraction[]> {
  return pages<SarvamInteraction>(settings, appId, 'interactions', `${range(from, to)}&include_transcript=true`);
}

/** The recording as Sarvam holds it (WAV), or null when there is none. */
export async function fetchRecording(appId: string, interactionId: string): Promise<{ buffer: Buffer; mime: string } | null> {
  const read = readSarvamSettings();
  if ('missing' in read) return null;
  const res = await fetch(scope(read.settings, appId, `recordings/${encodeURIComponent(interactionId)}`), {
    headers: { 'X-API-Key': read.settings.apiKey }, signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Sarvam answered ${res.status} for that recording`);
  return { buffer: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type')?.split(';')[0] || 'audio/wav' };
}
