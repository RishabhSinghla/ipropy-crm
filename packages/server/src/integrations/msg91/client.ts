/**
 * MSG91 — one account, two ways to reach a phone: SMS and RCS.
 *
 * This file only talks to MSG91. Who may be messaged, how many, and in what
 * order is decided in `bulk.ts`; opt-out is checked there, once, before anything
 * reaches this file.
 *
 * Two facts about India that shape the code:
 *  * **SMS needs a DLT-approved template.** MSG91 will not send free text. A
 *    campaign names a template (MSG91 calls it a "flow") and fills its blanks,
 *    e.g. `##name##`. The sender id and the wording live in that template.
 *  * **RCS needs an approved agent.** `rcsProjectId` comes from MSG91 → RCS. An
 *    RCS message to a phone that cannot receive RCS is not turned into an SMS
 *    here; that would be a different message with different rules.
 *
 * The authkey is sent in a header, never in the address, so it cannot end up in
 * a log line of ours or of a proxy.
 */
import { getMsg91ProviderSettings } from '../../core/settings/integrations.js';

const BASE = 'https://control.msg91.com/api/v5';

/** MSG91 takes up to a thousand recipients a call; stay well under it. */
export const MOST_PER_CALL = 200;

export interface SmsRecipient {
  /** Digits with country code, no plus: 919876543210. */
  mobile: string;
  /** The template's blanks, e.g. { name: 'Anita' }. */
  variables: Record<string, string>;
}

function settings(): { authKey: string; smsTemplateId: string; rcsProjectId: string } {
  const s = getMsg91ProviderSettings();
  if (!s.active) throw new Error('MSG91 is not switched on. Turn the card on in Admin → Integrations.');
  if (!s.authKey) throw new Error('MSG91 has no Auth Key saved. Add it in Admin → Integrations.');
  return s;
}

/** `+91 98765 43210`, `09876543210`, `9876543210` → `919876543210`. Null when it is not a mobile. */
export function toMsg91Number(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '');
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith('0') && /^[6-9]/.test(digits.slice(1))) return `91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith('91') && /^[6-9]/.test(digits.slice(2))) return digits;
  // Not an Indian mobile. Other countries are possible but each has its own
  // rules, so they are refused here rather than guessed at.
  return null;
}

async function call(path: string, authKey: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { authkey: authKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* MSG91 sometimes answers in plain text */ }
  if (!response.ok) throw new Error(whyItFailed(parsed, response.status));
  const failure = refusal(parsed);
  if (failure) throw new Error(failure);
  return parsed;
}

/** MSG91 answers HTTP 200 with `type: "error"` for most refusals, so the status alone proves nothing. */
export function refusal(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const type = String(b.type ?? b.status ?? '').toLowerCase();
  if (type === 'error' || type === 'fail' || type === 'failed' || b.hasError === true) {
    return whyItFailed(body, 200);
  }
  return null;
}

export function whyItFailed(body: unknown, status: number): string {
  if (typeof body === 'string' && body.trim()) return `MSG91 said: ${body.trim().slice(0, 200)}`;
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const said = b.message ?? b.errors ?? b.error;
    if (said) return `MSG91 said: ${typeof said === 'string' ? said : JSON.stringify(said)}`.slice(0, 300);
  }
  return `MSG91 returned HTTP ${status}.`;
}

/**
 * Send one DLT template to up to {@link MOST_PER_CALL} people, each with their own blanks.
 * Returns MSG91's request id, which is what its delivery report is looked up by.
 */
export async function sendSms(templateId: string, recipients: SmsRecipient[]): Promise<{ requestId: string }> {
  const s = settings();
  if (!templateId) throw new Error('No SMS template chosen. MSG91 sends only DLT-approved templates.');
  if (!recipients.length) throw new Error('No recipients.');
  if (recipients.length > MOST_PER_CALL) throw new Error(`At most ${MOST_PER_CALL} recipients per call.`);
  const answer = await call('/flow', s.authKey, {
    template_id: templateId,
    short_url: '0',
    realTimeResponse: '1',
    recipients: recipients.map((r) => ({ mobiles: r.mobile, ...r.variables })),
  }) as { message?: string; request_id?: string };
  return { requestId: String(answer?.request_id ?? answer?.message ?? '') };
}

/** Send one RCS text to up to {@link MOST_PER_CALL} numbers. Delivery is reported later, not in this answer. */
export async function sendRcsText(numbers: string[], text: string, ttlSeconds = 86_400): Promise<void> {
  const s = settings();
  if (!s.rcsProjectId) throw new Error('No RCS Project ID saved. Add it in Admin → Integrations.');
  if (!numbers.length) throw new Error('No recipients.');
  if (numbers.length > MOST_PER_CALL) throw new Error(`At most ${MOST_PER_CALL} recipients per call.`);
  await call('/rcs/send-rcs-message/bulk/', s.authKey, {
    customer_numbers: numbers,
    project_id: s.rcsProjectId,
    function_name: 'text_message',
    text,
    ttl: String(ttlSeconds),
  });
}

/**
 * A real, read-only question — what is left on the RCS wallet — so "Test connection"
 * proves the key is accepted without sending anyone a message or spending a paisa.
 */
export async function testMsg91(): Promise<{ ok: boolean; message: string }> {
  const s = getMsg91ProviderSettings();
  if (!s.authKey) return { ok: false, message: 'Paste the Auth Key first (MSG91 → top bar → AuthKey).' };
  try {
    const answer = await call('/subscriptions/fetchPrepaidBalance', s.authKey, { service: 'rcs' }) as {
      plan_status?: string; prepaid_balance?: number;
    };
    const gaps: string[] = [];
    if (!s.smsTemplateId) gaps.push('no SMS template id yet');
    if (!s.rcsProjectId) gaps.push('no RCS project id yet');
    const wallet = typeof answer?.prepaid_balance === 'number' ? ` RCS balance ₹${answer.prepaid_balance}.` : '';
    return {
      ok: true,
      message: `MSG91 accepted the Auth Key.${wallet}${gaps.length ? ` Still missing: ${gaps.join(', ')}.` : ''}`,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'MSG91 could not be reached.' };
  }
}
