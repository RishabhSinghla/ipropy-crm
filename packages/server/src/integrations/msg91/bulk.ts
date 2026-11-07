/**
 * Sending one SMS or RCS message to many people — on purpose, and once each.
 *
 * This is the WhatsApp campaign engine's twin (`integrations/whatsapp/business/
 * campaigns.ts`) and it keeps that engine's rule, which is written in this
 * repo's own history: a daily workflow whose conditions had emptied itself
 * queued 40,515 WhatsApp messages to 20,209 people, and nobody received one only
 * because no provider was connected. Luck, not a safeguard.
 *
 * So, as there:
 *  1. **Nothing sends until a person approves a number they have seen.** The
 *     count is passed back on approval; a mismatch refuses.
 *  2. **The audience and every person's wording are frozen at approval.** A
 *     saved list or a record edited afterwards cannot change a running campaign.
 *  3. **Once each**, by a unique index (`(bulk_id, record_id)`) and by number.
 *  4. **A ceiling**, and an extra confirmation above `NEEDS_CONFIRMING`.
 *  5. **Every refusal is a row somebody can read.**
 *  6. **Opt-out is checked twice** — when the audience is frozen and again just
 *     before each batch leaves, because somebody can reply STOP in between.
 *  7. **"Everybody" has to be said out loud.** An audience is a saved list or
 *     `everyone: true`; an empty filter is refused, not read as "all".
 *
 * Two differences from WhatsApp, both deliberate:
 *  * **Faster.** SMS has no 24-hour window and MSG91 takes a batch in one call, so
 *    a visit sends up to `MOST_PER_CALL` people a minute, not ten. A mistake can
 *    still be stopped with Pause inside a minute.
 *  * **A bigger ceiling.** The owner asked to reach every record in one go. The
 *    wallet balance at MSG91 is the other brake: it runs out before it can hurt.
 *
 * And one rule WhatsApp does not have: **promotional SMS may only go out between
 * 9 am and 9 pm India time** (TRAI). A campaign approved at night waits; nothing
 * is dropped.
 */
import type { FilterGroup } from '@ipropy/shared';
import { toInternational } from '@ipropy/shared';
import { db, transaction } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { BadRequestError, NotFoundError } from '../../utils/errors.js';
import { recordService } from '../../core/entity/recordService.js';
import type { ScopeContext } from '../../core/permissions/index.js';
import { getModule } from '../../core/metadata/registry.js';
import { filterOptedOut } from '../../core/consent/index.js';
import { getMsg91ProviderSettings } from '../../core/settings/integrations.js';
import { MOST_PER_CALL, sendRcsText, sendSms, toMsg91Number } from './client.js';

export type BulkChannel = 'sms' | 'rcs';

/** Above this, approving takes a second, explicit confirmation. */
export const NEEDS_CONFIRMING = 500;
/** And above this, nothing: split it into parts. Raise it here, on purpose, if it ever binds. */
export const MOST_WE_WILL_SEND = 50_000;

export interface Audience {
  view?: string;
  filter?: FilterGroup;
  /** Every record the approver may see. Must be said explicitly. */
  everyone?: boolean;
}

export interface Content {
  channel: BulkChannel;
  /** SMS: the DLT template. Falls back to the one saved on the MSG91 card. */
  templateId?: string;
  /** SMS: what fills each blank of the template. Values may hold {{field}} tokens. */
  variables?: Record<string, string>;
  /** RCS: the message, with {{field}} tokens. */
  body?: string;
}

// ---------------------------------------------------------------------------
// Pure rules — tested without a database
// ---------------------------------------------------------------------------

/** May this many people be messaged, on this approval? Same order of answers as WhatsApp's. */
export function audienceVerdict(input: { count: number; expected: number; confirmLarge?: boolean }): string | null {
  if (input.count !== input.expected) {
    return `This audience is ${input.count} people now, not the ${input.expected} you were shown. Check it and approve again.`;
  }
  if (input.count === 0) return 'Nobody in this audience has a mobile number we can message.';
  if (input.count > MOST_WE_WILL_SEND) {
    return `${input.count} is more than this CRM will send in one campaign (${MOST_WE_WILL_SEND}). Narrow the audience and send it in parts.`;
  }
  if (input.count > NEEDS_CONFIRMING && !input.confirmLarge) {
    return `${input.count} people is a large campaign. Confirm it explicitly to go ahead.`;
  }
  return null;
}

/** An audience must name itself. Returns the reason it does not, or null. */
export function audienceProblem(audience: Audience): string | null {
  if (audience.everyone === true) return null;
  if (audience.view) return null;
  return 'Choose a saved list, or say "everyone" on purpose. An empty audience is not read as everybody.';
}

/** 9 am to 9 pm in India. Promotional SMS outside this is blocked by the operators anyway. */
export function insidePromotionalHours(now: Date = new Date()): boolean {
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', hourCycle: 'h23',
  }).format(now));
  return hour >= 9 && hour < 21;
}

/** Fill `{{field}}` tokens from a record. Names what is empty rather than sending a hole. */
export function fillTokens(
  text: string,
  values: Record<string, unknown>,
  label: string,
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const filled = text.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_whole, name: string) => {
    const raw = name === 'label' ? label : values[name];
    const value = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
    if (!value) { missing.push(name); return ''; }
    return value;
  });
  return { text: filled, missing };
}

/** What one person will be sent, or why they cannot be. */
export function wordingFor(
  content: Content,
  values: Record<string, unknown>,
  label: string,
): { payload: Record<string, string>; missing: string[] } {
  if (content.channel === 'rcs') {
    const { text, missing } = fillTokens(content.body ?? '', values, label);
    return { payload: { text }, missing };
  }
  const payload: Record<string, string> = {};
  const missing: string[] = [];
  for (const [blank, source] of Object.entries(content.variables ?? {})) {
    const filled = fillTokens(source, values, label);
    payload[blank] = filled.text;
    missing.push(...filled.missing);
  }
  return { payload, missing: [...new Set(missing)] };
}

/** The reasons a campaign could never work, whoever is in it. */
export function contentProblem(content: Content): string | null {
  const s = getMsg91ProviderSettings();
  if (content.channel === 'sms') {
    if (!(content.templateId || s.smsTemplateId)) {
      return 'No SMS template. Paste the DLT template id from MSG91 → SMS → Templates, here or on the MSG91 card.';
    }
    return null;
  }
  if (!content.body?.trim()) return 'Write the RCS message first.';
  if (content.body.length > 2000) return 'RCS text is limited to 2,000 characters.';
  if (!s.rcsProjectId) return 'No RCS Project ID saved on the MSG91 card in Admin → Integrations.';
  return null;
}

// ---------------------------------------------------------------------------
// Reading the audience
// ---------------------------------------------------------------------------

interface Person {
  recordId: string;
  label: string;
  handle: string;
  payload: Record<string, string>;
}
interface Left { recordId: string; label: string; reason: string }

async function phoneFieldNames(moduleName: string): Promise<string[]> {
  const module = await getModule(moduleName);
  return (module?.fields ?? []).filter((field) => field.uitype === 'phone').map((field) => field.name);
}

/** First phone on the record that is an Indian mobile, as +91…, or why not. */
export function firstMobile(
  values: Record<string, unknown>,
  phoneFields: string[],
): { handle: string } | { reason: string } {
  let sawANumber = false;
  for (const name of phoneFields) {
    const raw = typeof values[name] === 'string' ? values[name] as string : '';
    if (!raw.replace(/\D/g, '')) continue;
    sawANumber = true;
    const international = toInternational(values.country_code as string | undefined, raw);
    const digits = toMsg91Number(international);
    if (digits) return { handle: `+${digits}` };
  }
  return { reason: sawANumber ? 'not an Indian mobile number' : 'no mobile number on the record' };
}

async function resolveAudience(
  ctx: ScopeContext,
  moduleName: string,
  audience: Audience,
  content: Content,
): Promise<{ reachable: Person[]; unreachable: Left[]; total: number }> {
  const problem = audienceProblem(audience);
  if (problem) throw new BadRequestError(problem);

  const phoneFields = await phoneFieldNames(moduleName);
  const reachable: Person[] = [];
  const unreachable: Left[] = [];
  const seen = new Set<string>();
  let total = 0;

  const pageSize = 200;
  for (let page = 1; ; page += 1) {
    const result = await recordService.listRecords(ctx, moduleName, {
      view: audience.everyone ? undefined : audience.view,
      filter: audience.everyone ? undefined : audience.filter,
      page,
      pageSize,
    });
    total = result.total;
    for (const row of result.rows) {
      const mobile = firstMobile(row.values, phoneFields);
      if ('reason' in mobile) { unreachable.push({ recordId: row.id, label: row.label, reason: mobile.reason }); continue; }
      // One message per number: two records sharing a husband-and-wife phone are
      // two rows here and one handset there.
      if (seen.has(mobile.handle)) {
        unreachable.push({ recordId: row.id, label: row.label, reason: 'another record in this audience has the same number' });
        continue;
      }
      const wording = wordingFor(content, row.values, row.label);
      if (wording.missing.length) {
        unreachable.push({ recordId: row.id, label: row.label, reason: `empty on the record: ${wording.missing.join(', ')}` });
        continue;
      }
      seen.add(mobile.handle);
      reachable.push({ recordId: row.id, label: row.label, handle: mobile.handle, payload: wording.payload });
    }
    if (page * pageSize >= result.total || !result.rows.length) break;
    // A runaway audience is refused at approval, but the walk itself must not be
    // what finds that out by reading a hundred thousand rows first.
    if (reachable.length > MOST_WE_WILL_SEND) break;
  }

  // Opt-out, first pass: people who asked not to be messaged on this channel.
  const stopped = await filterOptedOut(reachable.map((p) => p.handle), content.channel);
  const kept: Person[] = [];
  for (const person of reachable) {
    if (stopped.has(person.handle)) {
      unreachable.push({ recordId: person.recordId, label: person.label, reason: 'asked not to be messaged' });
    } else kept.push(person);
  }
  return { reachable: kept, unreachable, total };
}

/** The wording shown in the preview — what the person will actually read. */
function previewText(content: Content, payload: Record<string, string>): string {
  if (content.channel === 'rcs') return payload.text ?? '';
  const blanks = Object.entries(payload).map(([k, v]) => `${k} = ${v}`).join(' · ');
  return blanks ? `SMS template ${content.templateId || getMsg91ProviderSettings().smsTemplateId} — ${blanks}` : 'SMS template (no blanks)';
}

export async function previewBulk(input: {
  ctx: ScopeContext; module: string; audience: Audience; content: Content;
}): Promise<{
  total: number; reachable: number;
  sample: { recordId: string; label: string; to: string; preview: string }[];
  skipped: { label: string; reason: string }[];
  setupProblem: string | null;
  inSendingHours: boolean;
}> {
  const setupProblem = contentProblem(input.content);
  const found = await resolveAudience(input.ctx, input.module, input.audience, input.content);
  return {
    total: found.total,
    reachable: found.reachable.length,
    sample: found.reachable.slice(0, 5).map((p) => ({
      recordId: p.recordId, label: p.label, to: p.handle, preview: previewText(input.content, p.payload),
    })),
    skipped: found.unreachable.slice(0, 10).map((l) => ({ label: l.label, reason: l.reason })),
    setupProblem,
    inSendingHours: insidePromotionalHours(),
  };
}

// ---------------------------------------------------------------------------
// Writing and approving
// ---------------------------------------------------------------------------

export async function createBulk(input: {
  name: string; module: string; audience: Audience; content: Content; userId: string;
}): Promise<{ id: string }> {
  const problem = audienceProblem(input.audience) ?? contentProblem(input.content);
  if (problem) throw new BadRequestError(problem);
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_bulk_message (name, channel, module_name, audience, template_id, variables, body, created_by)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,$8) RETURNING id`,
    [
      input.name, input.content.channel, input.module, JSON.stringify(input.audience),
      input.content.templateId?.trim() || null, JSON.stringify(input.content.variables ?? {}),
      input.content.body ?? null, input.userId,
    ],
  );
  return { id: row!.id };
}

interface BulkRow {
  id: string; channel: BulkChannel; module_name: string; audience: Audience;
  template_id: string | null; variables: Record<string, string>; body: string | null; status: string;
}

async function readBulk(id: string): Promise<BulkRow> {
  const row = await db.queryOne<BulkRow>(
    `SELECT id, channel, module_name, audience, template_id, variables, body, status
       FROM ipy_bulk_message WHERE id = $1`, [id],
  );
  if (!row) throw new NotFoundError('No such campaign.');
  return row;
}

function contentOf(row: BulkRow): Content {
  return {
    channel: row.channel, templateId: row.template_id ?? undefined,
    variables: row.variables ?? {}, body: row.body ?? undefined,
  };
}

export async function approveBulk(input: {
  ctx: ScopeContext; userId: string; bulkId: string; expectedCount: number; confirmLarge?: boolean;
}): Promise<{ frozen: number; skipped: number }> {
  const row = await readBulk(input.bulkId);
  if (row.status !== 'draft') throw new BadRequestError('Only a draft campaign can be approved.');
  const content = contentOf(row);
  const problem = contentProblem(content);
  if (problem) throw new BadRequestError(problem);
  if (!getMsg91ProviderSettings().active) {
    throw new BadRequestError('MSG91 is not switched on, so nothing could be sent.');
  }

  const found = await resolveAudience(input.ctx, row.module_name, row.audience ?? {}, content);
  const refusal = audienceVerdict({
    count: found.reachable.length, expected: input.expectedCount, confirmLarge: input.confirmLarge,
  });
  if (refusal) throw new BadRequestError(refusal);

  await transaction(async (conn) => {
    for (const person of found.reachable) {
      await conn.query(
        `INSERT INTO ipy_bulk_message_recipient (bulk_id, record_id, handle, payload)
         VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (bulk_id, record_id) DO NOTHING`,
        [input.bulkId, person.recordId, person.handle, JSON.stringify(person.payload)],
      );
    }
    // The ones left out are written down too, so "reached 340 of 1,200" can say which 860 and why.
    for (const left of found.unreachable) {
      await conn.query(
        `INSERT INTO ipy_bulk_message_recipient (bulk_id, record_id, handle, status, error)
         VALUES ($1,$2,'','skipped',$3) ON CONFLICT (bulk_id, record_id) DO NOTHING`,
        [input.bulkId, left.recordId, left.reason],
      );
    }
    await conn.query(
      `UPDATE ipy_bulk_message SET status='running', approved_by=$2, approved_at=now(),
              approved_count=$3, updated_at=now() WHERE id=$1`,
      [input.bulkId, input.userId, found.reachable.length],
    );
  });
  logger.info({ bulkId: input.bulkId, channel: row.channel, frozen: found.reachable.length }, 'bulk message approved');
  return { frozen: found.reachable.length, skipped: found.unreachable.length };
}

export async function setBulkStatus(id: string, status: 'paused' | 'running' | 'cancelled'): Promise<void> {
  const row = await readBulk(id);
  if (row.status === 'done' || row.status === 'cancelled') throw new BadRequestError('This campaign has finished.');
  if (status === 'running' && row.status !== 'paused') throw new BadRequestError('Only a paused campaign can be resumed.');
  await db.query(`UPDATE ipy_bulk_message SET status=$2, updated_at=now() WHERE id=$1`, [id, status]);
}

// ---------------------------------------------------------------------------
// One test message
// ---------------------------------------------------------------------------

/**
 * Send one message to one number — the owner's own, before a campaign.
 *
 * Deliberately not a campaign: no list, no approval, no row. It still refuses a
 * number that asked not to be messaged, and still refuses anything that is not
 * an Indian mobile. Blanks are plain text here (there is no record to read).
 */
export async function sendTestMessage(input: { to: string; content: Content }): Promise<{ to: string }> {
  const problem = contentProblem(input.content);
  if (problem) throw new BadRequestError(problem);
  if (!getMsg91ProviderSettings().active) throw new BadRequestError('MSG91 is not switched on.');
  const digits = toMsg91Number(toInternational(undefined, input.to));
  if (!digits) throw new BadRequestError('That is not an Indian mobile number.');
  const handle = `+${digits}`;
  if ((await filterOptedOut([handle], input.content.channel)).has(handle)) {
    throw new BadRequestError('That number has asked not to be messaged.');
  }
  if (input.content.channel === 'sms') {
    const templateId = input.content.templateId || getMsg91ProviderSettings().smsTemplateId;
    await sendSms(templateId, [{ mobile: digits, variables: input.content.variables ?? {} }]);
  } else {
    await sendRcsText([digits], input.content.body ?? '');
  }
  logger.info({ channel: input.content.channel }, 'MSG91 test message sent');
  return { to: handle };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * Send the next batch of the oldest running campaign.
 *
 * One campaign per visit, oldest first: two campaigns approved together simply
 * take turns, and the wallet is spent in the order people decided.
 */
export async function sendBulkBatch(now: Date = new Date()): Promise<{ sent: number; failed: number }> {
  if (!getMsg91ProviderSettings().active) return { sent: 0, failed: 0 };
  if (!insidePromotionalHours(now)) return { sent: 0, failed: 0 };

  const campaign = await db.queryOne<BulkRow>(
    `SELECT c.id, c.channel, c.module_name, c.audience, c.template_id, c.variables, c.body, c.status
       FROM ipy_bulk_message c
      WHERE c.status = 'running'
        AND EXISTS (SELECT 1 FROM ipy_bulk_message_recipient r WHERE r.bulk_id = c.id AND r.status = 'pending')
      ORDER BY c.approved_at LIMIT 1`,
  );
  if (!campaign) { await finishEmpty(); return { sent: 0, failed: 0 }; }

  // Claimed inside a transaction with SKIP LOCKED, so a second process cannot take the same people.
  const claimed = await transaction(async (conn) => {
    const due = await conn.query<{ id: string; handle: string; payload: Record<string, string> }>(
      `SELECT id, handle, payload FROM ipy_bulk_message_recipient
        WHERE bulk_id = $1 AND status = 'pending'
        ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [campaign.id, MOST_PER_CALL],
    );
    if (due.rows.length) {
      await conn.query(
        `UPDATE ipy_bulk_message_recipient SET status = 'sending', claimed_at = now() WHERE id = ANY($1::uuid[])`,
        [due.rows.map((r) => r.id)],
      );
    }
    return due.rows;
  });
  if (!claimed.length) return { sent: 0, failed: 0 };

  // Opt-out, second pass: somebody may have replied STOP since approval.
  const stopped = await filterOptedOut(claimed.map((r) => r.handle), campaign.channel);
  const going = claimed.filter((r) => !stopped.has(r.handle));
  for (const r of claimed.filter((c) => stopped.has(c.handle))) {
    await mark([r.id], 'skipped', 'asked not to be messaged since this was approved');
  }
  if (!going.length) { await finishEmpty(); return { sent: 0, failed: 0 }; }

  try {
    const ids = going.map((r) => r.id);
    if (campaign.channel === 'sms') {
      const templateId = campaign.template_id || getMsg91ProviderSettings().smsTemplateId;
      const answer = await sendSms(templateId, going.map((r) => ({ mobile: r.handle.replace('+', ''), variables: r.payload })));
      await markSent(ids, answer.requestId);
    } else {
      // RCS has one text per person, so people with the same words go together.
      const byText = new Map<string, typeof going>();
      for (const r of going) byText.set(r.payload.text ?? '', [...(byText.get(r.payload.text ?? '') ?? []), r]);
      for (const [text, group] of byText) {
        try {
          await sendRcsText(group.map((r) => r.handle.replace('+', '')), text);
          await markSent(group.map((r) => r.id), '');
        } catch (err) {
          await mark(group.map((r) => r.id), 'failed', reason(err));
        }
      }
    }
  } catch (err) {
    // The whole call was refused (bad key, empty wallet, template not approved).
    // Marked failed, not retried: retrying a refusal at 200 people a minute helps nobody.
    await mark(going.map((r) => r.id), 'failed', reason(err));
    logger.warn({ bulkId: campaign.id, err: reason(err) }, 'MSG91 refused a bulk batch');
  }

  await finishEmpty();
  const counts = await db.queryOne<{ sent: string; failed: string }>(
    `SELECT COUNT(*) FILTER (WHERE status='sent') AS sent, COUNT(*) FILTER (WHERE status='failed') AS failed
       FROM ipy_bulk_message_recipient WHERE id = ANY($1::uuid[])`, [going.map((r) => r.id)],
  );
  return { sent: Number(counts?.sent ?? 0), failed: Number(counts?.failed ?? 0) };
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : 'the send was refused';
}

async function markSent(ids: string[], providerRef: string): Promise<void> {
  await db.query(
    `UPDATE ipy_bulk_message_recipient SET status='sent', sent_at=now(), provider_ref=NULLIF($2,''), error=NULL
      WHERE id = ANY($1::uuid[])`, [ids, providerRef],
  );
}

async function mark(ids: string[], status: 'failed' | 'skipped', error: string): Promise<void> {
  await db.query(
    `UPDATE ipy_bulk_message_recipient SET status=$2, error=$3 WHERE id = ANY($1::uuid[])`,
    [ids, status, error.slice(0, 500)],
  );
}

/** A running campaign with nothing left to send is finished. */
async function finishEmpty(): Promise<void> {
  await db.query(
    `UPDATE ipy_bulk_message SET status='done', updated_at=now()
      WHERE status='running' AND NOT EXISTS (
        SELECT 1 FROM ipy_bulk_message_recipient r
         WHERE r.bulk_id = ipy_bulk_message.id AND r.status IN ('pending','sending'))`,
  );
}

/**
 * Anything left 'sending' by a process that died mid-batch goes back to
 * 'pending'. Safe only because MSG91 is asked once per claim and a crash before
 * `markSent` means we never learned the answer — the rare duplicate is a better
 * failure than a person silently dropped, and it is logged.
 */
export async function releaseStuckBatches(): Promise<void> {
  // Judged by when the batch was claimed, never by when the campaign was made:
  // another process's batch that is being sent right now must not be taken back.
  const released = await db.query(
    `UPDATE ipy_bulk_message_recipient SET status='pending', claimed_at=NULL
      WHERE status='sending' AND claimed_at < now() - interval '15 minutes'`,
  );
  if (released.rowCount) logger.warn({ released: released.rowCount }, 'bulk messages: released stuck batch');
}

// ---------------------------------------------------------------------------
// Reading back
// ---------------------------------------------------------------------------

export interface BulkSummary {
  id: string; name: string; channel: BulkChannel; moduleName: string;
  status: 'draft' | 'running' | 'paused' | 'done' | 'cancelled';
  approvedCount: number | null; approvedAt: string | null; createdAt: string;
  counts: { pending: number; sent: number; failed: number; skipped: number };
}

export async function listBulk(): Promise<BulkSummary[]> {
  const { rows } = await db.query<{
    id: string; name: string; channel: BulkChannel; module_name: string; status: BulkSummary['status'];
    approved_count: number | null; approved_at: string | null; created_at: string;
    pending: string; sent: string; failed: string; skipped: string;
  }>(
    `SELECT c.id, c.name, c.channel, c.module_name, c.status, c.approved_count, c.approved_at, c.created_at,
            COUNT(*) FILTER (WHERE r.status IN ('pending','sending')) AS pending,
            COUNT(*) FILTER (WHERE r.status = 'sent')    AS sent,
            COUNT(*) FILTER (WHERE r.status = 'failed')  AS failed,
            COUNT(*) FILTER (WHERE r.status = 'skipped') AS skipped
       FROM ipy_bulk_message c
       LEFT JOIN ipy_bulk_message_recipient r ON r.bulk_id = c.id
      GROUP BY c.id ORDER BY c.created_at DESC LIMIT 100`,
  );
  return rows.map((row) => ({
    id: row.id, name: row.name, channel: row.channel, moduleName: row.module_name, status: row.status,
    approvedCount: row.approved_count, approvedAt: row.approved_at, createdAt: row.created_at,
    counts: { pending: Number(row.pending), sent: Number(row.sent), failed: Number(row.failed), skipped: Number(row.skipped) },
  }));
}

export async function bulkRecipients(bulkId: string, status?: string): Promise<{
  recordId: string; label: string; handle: string; status: string; error: string | null; sentAt: string | null;
}[]> {
  const { rows } = await db.query<{
    record_id: string; label: string; handle: string; status: string; error: string | null; sent_at: string | null;
  }>(
    `SELECT r.record_id, rec.label, r.handle, r.status, r.error, r.sent_at
       FROM ipy_bulk_message_recipient r JOIN ipy_record rec ON rec.id = r.record_id
      WHERE r.bulk_id = $1 ${status ? 'AND r.status = $2' : ''}
      ORDER BY r.status, rec.label LIMIT 500`,
    status ? [bulkId, status] : [bulkId],
  );
  return rows.map((row) => ({
    recordId: row.record_id, label: row.label, handle: row.handle,
    status: row.status, error: row.error, sentAt: row.sent_at,
  }));
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

const SEND_EVERY_MS = 60_000;
let timer: NodeJS.Timeout | null = null;
let sending = false;

export function startBulkSending(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (sending) return;
    sending = true;
    void releaseStuckBatches()
      .then(() => sendBulkBatch())
      .then((result) => { if (result.sent || result.failed) logger.info(result, 'bulk message batch sent'); })
      .catch((err) => logger.warn({ err }, 'bulk message batch failed'))
      .finally(() => { sending = false; });
  }, SEND_EVERY_MS);
  timer.unref?.();
}

export function stopBulkSending(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
