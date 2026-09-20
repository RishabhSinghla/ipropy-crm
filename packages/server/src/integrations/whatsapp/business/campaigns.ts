/**
 * Sending one approved template to many people — on purpose, and once each.
 *
 * **Read migration `161` before changing anything here.** This feature exists
 * under one rule, and the rule is written in this repo's own history: a daily
 * workflow whose condition list had emptied itself queued 40,515 WhatsApp
 * messages to 20,209 people, and nobody received one only because no provider
 * was connected. Luck, not a safeguard.
 *
 * A campaign is deliberately "message many people", so "refuse to match
 * everybody" cannot be the protection. These are:
 *
 *  1. **Nothing sends until a person approves a number they have seen.** The
 *     count is passed back on approval and a mismatch refuses — so an audience
 *     that changed between reading it and approving it stops rather than
 *     surprises.
 *  2. **The audience is frozen at approval.** One row per recipient, written
 *     then. A saved view edited afterwards cannot grow a running campaign,
 *     because nothing re-reads the view.
 *  3. **Once each**, by a unique index rather than by whoever is careful.
 *  4. **A ceiling.** Over `NEEDS_CONFIRMING` an extra confirmation is
 *     required; over `MOST_WE_WILL_SEND` it is refused outright.
 *  5. **Every refusal is a row somebody can read** — opted out, no number, a
 *     blank the template needed. The birthday messages were invisible until
 *     somebody thought to count the queue.
 *  6. **Opt-out and the 24-hour window are not re-implemented here.** Every
 *     message goes through `sendOnBusinessNumber`, the one send path, which
 *     already refuses both. A refusal marks that recipient and the campaign
 *     carries on.
 *
 * Deliberately absent: a schedule. A campaign that fires itself at nine in the
 * morning is precisely the shape of the rule that caused all this.
 */
import type { FilterGroup } from '@ipropy/shared';
import { db, transaction, type Tx } from '../../../db/pool.js';
import { logger } from '../../../utils/logger.js';
import { BadRequestError, NotFoundError } from '../../../utils/errors.js';
import { recordService } from '../../../core/entity/recordService.js';
import { buildScopeContext, type ScopeContext } from '../../../core/permissions/index.js';
import { loadUser } from '../../../middleware/auth.js';
import { getModule } from '../../../core/metadata/registry.js';
import { matchKey } from '../matchContact.js';
import { organisationName, resolveTemplate } from './templates.js';
import { sendOnBusinessNumber } from './send.js';
import { activeBusinessProvider } from './registry.js';

/** Above this, approving takes a second, explicit confirmation. */
export const NEEDS_CONFIRMING = 500;
/**
 * And above this, nothing. Twenty thousand messages have been queued by
 * accident in this CRM once already; a number that large is a mistake far more
 * often than it is a decision, and splitting a genuine one into batches costs
 * an afternoon rather than a reputation.
 */
export const MOST_WE_WILL_SEND = 5_000;

/** How many go out per visit. Slow on purpose — see `startCampaignSending`. */
const PER_VISIT = 10;

/**
 * May this many people be messaged, on this approval?
 *
 * Pure, and exported, because it is the whole of the protection and a test
 * should be able to walk every threshold without a database. The order
 * matters: *what changed* is said before *how big it is*, because an audience
 * that moved under somebody is the more alarming of the two answers.
 */
export function audienceVerdict(input: {
  count: number;
  expected: number;
  confirmLarge?: boolean;
}): string | null {
  if (input.count !== input.expected) {
    return `This audience is ${input.count} people now, not the ${input.expected} you were shown. `
      + 'Check it and approve again.';
  }
  if (input.count === 0) return 'Nobody in this audience has a WhatsApp number.';
  if (input.count > MOST_WE_WILL_SEND) {
    return `${input.count} is more than this CRM will send in one campaign (${MOST_WE_WILL_SEND}). `
      + 'Narrow the audience and send it in parts.';
  }
  if (input.count > NEEDS_CONFIRMING && !input.confirmLarge) {
    return `${input.count} people is a large campaign. Confirm it explicitly to go ahead.`;
  }
  return null;
}

export interface Audience {
  /** A saved view's id, or a filter typed in the campaign itself. */
  view?: string;
  filter?: FilterGroup;
}

export interface CampaignRow {
  id: string;
  name: string;
  moduleName: string;
  templateId: string;
  templateName: string;
  status: 'draft' | 'running' | 'paused' | 'done' | 'cancelled';
  audience: Audience;
  approvedCount: number | null;
  approvedAt: string | null;
  createdAt: string;
  counts: { pending: number; sent: number; failed: number; skipped: number };
}

/**
 * Who this campaign would reach, and what the first few would read.
 *
 * Writes nothing. Deliberately the same call the screen makes before it offers
 * an Approve button, so the number somebody approves is a number they have
 * been shown rather than one the server worked out afterwards.
 *
 * The audience is resolved through `listRecords`, so a rep only ever reaches
 * records that rep may see — a campaign is not a way around the role
 * hierarchy.
 */
export async function previewCampaign(input: {
  ctx: ScopeContext;
  module: string;
  audience: Audience;
  templateId: string;
  agentName: string;
  samples?: number;
}): Promise<{
  total: number;
  reachable: number;
  sample: { recordId: string; label: string; to: string; preview: string; missing: string[] }[];
  skipped: { label: string; reason: string }[];
  /**
   * Blanks that are unfilled for *everybody*, because nothing is mapped to
   * them at all — as opposed to a mapped field that happens to be empty on one
   * record. This is a property of the template, not of a person, and it means
   * the campaign would reach nobody: WhatsApp refuses a template with a hole.
   *
   * It has to be its own answer because `reachable` cannot see it. On
   * 20 September 2026 a campaign previewed as "Send to 84" with all 84 rows
   * reading *"Will be skipped"* — the approver is shown a number, approves it,
   * and not one message goes. A count that is not the count is the exact
   * failure this feature was built to prevent.
   */
  unmapped: string[];
}> {
  const page = await recordService.listRecords(input.ctx, input.module, {
    view: input.audience.view,
    filter: input.audience.filter,
    page: 1,
    pageSize: Math.min(input.samples ?? 5, 25),
  });

  const orgName = await organisationName();
  const phoneFields = await phoneFieldNames(input.module);

  const sample: { recordId: string; label: string; to: string; preview: string; missing: string[] }[] = [];
  const skipped: { label: string; reason: string }[] = [];

  for (const row of page.rows) {
    const to = firstHandle(row.values, phoneFields);
    if (!to) {
      skipped.push({ label: row.label, reason: 'no WhatsApp number on the record' });
      continue;
    }
    const filled = await resolveTemplate({
      ctx: input.ctx,
      templateId: input.templateId,
      module: input.module,
      recordId: row.id,
      agentName: input.agentName,
      orgName,
    });
    sample.push({
      recordId: row.id,
      label: row.label,
      to,
      preview: filled.preview,
      missing: filled.missing.map((gap) => `{{${gap.slot}}} ${gap.reason}`),
    });
  }

  /*
    `total` is everybody the audience matches; `reachable` is how many of them
    the CRM can actually message. Two numbers rather than one, because "1,200
    contacts" and "340 of them have a number" are different facts and somebody
    approving needs the second.
  */
  const reachable = await countReachable(input.ctx, input.module, input.audience, phoneFields);
  /*
    Read off one sample row, because a setup gap is the same for every record.
    "is empty on this record" is deliberately not one of these: that is a real
    per-person skip, and the campaign still goes to everybody else.
  */
  const unmapped = (sample[0]?.missing ?? []).filter((gap) => (
    gap.includes('nothing is mapped to it') || gap.includes('needs setting again')
  ));
  return { total: page.total, reachable, sample, skipped, unmapped };
}

/**
 * Freeze the audience and let it run.
 *
 * `expectedCount` is what the person was shown. If the audience has moved
 * since — somebody edited the view, a lead was created — this refuses and says
 * so rather than sending to a number nobody agreed to.
 */
export async function approveCampaign(input: {
  ctx: ScopeContext;
  userId: string;
  campaignId: string;
  expectedCount: number;
  confirmLarge?: boolean;
}): Promise<{ frozen: number; skipped: number }> {
  const campaign = await readCampaign(input.campaignId);
  if (campaign.status !== 'draft') {
    throw new BadRequestError('Only a draft campaign can be approved.');
  }
  if (!activeBusinessProvider()) {
    throw new BadRequestError('No official WhatsApp provider is switched on, so nothing could be sent.');
  }

  const phoneFields = await phoneFieldNames(campaign.moduleName);
  const recipients = await resolveAudience(input.ctx, campaign.moduleName, campaign.audience, phoneFields);

  const refusal = audienceVerdict({
    count: recipients.reachable.length,
    expected: input.expectedCount,
    confirmLarge: input.confirmLarge,
  });
  if (refusal) throw new BadRequestError(refusal);

  await transaction(async (conn: Tx) => {
    for (const person of recipients.reachable) {
      await conn.query(
        `INSERT INTO ipy_campaign_recipient (campaign_id, record_id, handle)
         VALUES ($1, $2, $3) ON CONFLICT (campaign_id, record_id) DO NOTHING`,
        [input.campaignId, person.recordId, person.handle],
      );
    }
    /*
      The ones with no number are written down too, as `skipped`. A campaign
      that reached 340 of 1,200 has to be able to say which 860 and why —
      otherwise the only way to find out is to ask each of them.
    */
    for (const person of recipients.unreachable) {
      await conn.query(
        `INSERT INTO ipy_campaign_recipient (campaign_id, record_id, handle, status, error)
         VALUES ($1, $2, '', 'skipped', $3) ON CONFLICT (campaign_id, record_id) DO NOTHING`,
        [input.campaignId, person.recordId, person.reason],
      );
    }
    await conn.query(
      `UPDATE ipy_campaign
          SET status = 'running', approved_by = $2, approved_at = now(),
              approved_count = $3, updated_at = now()
        WHERE id = $1`,
      [input.campaignId, input.userId, recipients.reachable.length],
    );
  });

  logger.info(
    { campaignId: input.campaignId, frozen: recipients.reachable.length, skipped: recipients.unreachable.length },
    'campaign approved',
  );
  return { frozen: recipients.reachable.length, skipped: recipients.unreachable.length };
}

export async function setCampaignStatus(campaignId: string, status: 'paused' | 'running' | 'cancelled'): Promise<void> {
  const campaign = await readCampaign(campaignId);
  if (campaign.status === 'done' || campaign.status === 'cancelled') {
    throw new BadRequestError('This campaign has finished.');
  }
  if (status === 'running' && campaign.status !== 'paused') {
    throw new BadRequestError('Only a paused campaign can be resumed.');
  }
  await db.query(`UPDATE ipy_campaign SET status = $2, updated_at = now() WHERE id = $1`, [campaignId, status]);
}

/**
 * Send the next few, for every campaign that is running.
 *
 * Every message goes through `sendOnBusinessNumber` — the one send path — so
 * opt-out, the 24-hour window and the provider's own capabilities are decided
 * in exactly one place. A refusal is that recipient's row and nothing more:
 * one person who has opted out must not stop the other three hundred.
 */
export async function sendCampaignBatch(): Promise<{ sent: number; failed: number }> {
  if (!activeBusinessProvider()) return { sent: 0, failed: 0 };

  const { rows: due } = await db.query<{
    id: string; campaign_id: string; record_id: string; handle: string;
    module_name: string; template_id: string; approved_by: string | null;
  }>(
    `SELECT r.id, r.campaign_id, r.record_id, r.handle,
            c.module_name, c.template_id, c.approved_by
       FROM ipy_campaign_recipient r
       JOIN ipy_campaign c ON c.id = r.campaign_id
      WHERE r.status = 'pending' AND c.status = 'running'
      ORDER BY r.created_at
      LIMIT $1`,
    [PER_VISIT],
  );
  if (!due.length) {
    await finishEmptyCampaigns();
    return { sent: 0, failed: 0 };
  }

  const orgName = await organisationName();
  let sent = 0;
  let failed = 0;

  for (const row of due) {
    if (!row.approved_by) {
      await mark(row.id, 'failed', 'the person who approved this campaign no longer has an account');
      failed += 1;
      continue;
    }
    try {
      /*
        The template is filled **per recipient, now**, against that record —
        which is the whole point of a template mapping. It is also read as the
        approver, so a campaign cannot put a value in front of a customer that
        the person who approved it was not allowed to see.
      */
      const ctx = await contextFor(row.approved_by);
      const filled = await resolveTemplate({
        ctx,
        templateId: row.template_id,
        module: row.module_name,
        recordId: row.record_id,
        agentName: ctx.user.fullName ?? '',
        orgName,
      });
      if (filled.missing.length) {
        // Named, not sent blank: WhatsApp refuses a template with a hole in it
        // anyway, and "failed" would send somebody hunting.
        await mark(row.id, 'skipped', filled.missing.map((gap) => `{{${gap.slot}}} ${gap.reason}`).join('; '));
        continue;
      }
      const result = await sendOnBusinessNumber({
        userId: row.approved_by,
        to: row.handle,
        template: { name: filled.name, language: filled.language, params: filled.params },
        recordId: row.record_id,
      });
      await db.query(
        `UPDATE ipy_campaign_recipient
            SET status = 'sent', message_id = $2, sent_at = now(), error = NULL
          WHERE id = $1`,
        [row.id, result.messageId],
      );
      sent += 1;
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'the send was refused';
      /*
        An opt-out or a shut window is the customer's answer, not a fault, so
        it reads as `skipped`. Anything else is a failure somebody should look
        at. Both are rows either way — the campaign carries on.
      */
      const theirChoice = /opted out|24-hour window/i.test(reason);
      await mark(row.id, theirChoice ? 'skipped' : 'failed', reason);
      if (!theirChoice) failed += 1;
    }
  }

  await finishEmptyCampaigns();
  return { sent, failed };
}

async function mark(recipientId: string, status: 'failed' | 'skipped', error: string): Promise<void> {
  await db.query(
    `UPDATE ipy_campaign_recipient SET status = $2, error = $3 WHERE id = $1`,
    [recipientId, status, error.slice(0, 500)],
  );
}

/** A running campaign with nothing left pending is finished. */
async function finishEmptyCampaigns(): Promise<void> {
  await db.query(
    `UPDATE ipy_campaign SET status = 'done', updated_at = now()
      WHERE status = 'running'
        AND NOT EXISTS (
          SELECT 1 FROM ipy_campaign_recipient r
           WHERE r.campaign_id = ipy_campaign.id AND r.status = 'pending'
        )`,
  );
}

// ---------------------------------------------------------------------------
// Reading the audience
// ---------------------------------------------------------------------------

/** Every phone field this module has, in the module's own order. */
async function phoneFieldNames(moduleName: string): Promise<string[]> {
  const module = await getModule(moduleName);
  return (module?.fields ?? [])
    .filter((field) => field.uitype === 'phone')
    .map((field) => field.name);
}

/**
 * Act as whoever approved the campaign, not as the system.
 *
 * A campaign is somebody's decision, and the messages it sends carry values
 * read off records — so it reads them with that person's own permissions. A
 * system context would bypass them, and a rep's campaign could then put a
 * budget in front of a customer that the rep was never allowed to see.
 */
async function contextFor(userId: string): Promise<ScopeContext & { user: { fullName: string | null } }> {
  const user = await loadUser(userId);
  if (!user) throw new BadRequestError('The person who approved this campaign no longer has an account.');
  return await buildScopeContext(user) as ScopeContext & { user: { fullName: string | null } };
}

/** The first phone on a record that WhatsApp could actually reach. */
function firstHandle(values: Record<string, unknown>, phoneFields: string[]): string | null {
  for (const name of phoneFields) {
    const handle = matchKey(typeof values[name] === 'string' ? values[name] as string : null);
    if (handle) return handle;
  }
  return null;
}

/**
 * Walk the whole audience, in pages.
 *
 * Paged rather than one query, because this runs through `listRecords` on
 * purpose — the permission layers, the saved view's own filter and the field
 * masking all apply, and none of that exists in a bare SELECT.
 */
async function resolveAudience(
  ctx: ScopeContext,
  moduleName: string,
  audience: Audience,
  phoneFields: string[],
): Promise<{
  reachable: { recordId: string; handle: string }[];
  unreachable: { recordId: string; reason: string }[];
}> {
  const reachable: { recordId: string; handle: string }[] = [];
  const unreachable: { recordId: string; reason: string }[] = [];
  const seen = new Set<string>();

  const pageSize = 200;
  for (let page = 1; ; page += 1) {
    const result = await recordService.listRecords(ctx, moduleName, {
      view: audience.view,
      filter: audience.filter,
      page,
      pageSize,
    });
    for (const row of result.rows) {
      const handle = firstHandle(row.values, phoneFields);
      if (!handle) {
        unreachable.push({ recordId: row.id, reason: 'no WhatsApp number on the record' });
        continue;
      }
      /*
        One message per *number*, not per record. Two contacts sharing a
        husband-and-wife phone are two rows in the CRM and one person holding
        one handset, and sending them the same offer twice is the thing that
        gets a business number reported.
      */
      if (seen.has(handle)) {
        unreachable.push({ recordId: row.id, reason: 'another record in this audience has the same number' });
        continue;
      }
      seen.add(handle);
      reachable.push({ recordId: row.id, handle });
    }
    if (page * pageSize >= result.total || !result.rows.length) break;
    // A runaway audience is refused at approval, but the walk itself must not
    // be what discovers that by reading a hundred thousand rows first.
    if (reachable.length > MOST_WE_WILL_SEND) break;
  }
  return { reachable, unreachable };
}

async function countReachable(
  ctx: ScopeContext,
  moduleName: string,
  audience: Audience,
  phoneFields: string[],
): Promise<number> {
  const resolved = await resolveAudience(ctx, moduleName, audience, phoneFields);
  return resolved.reachable.length;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

async function readCampaign(id: string): Promise<{ status: string; moduleName: string; audience: Audience }> {
  const row = await db.queryOne<{ status: string; module_name: string; audience: Audience }>(
    `SELECT status, module_name, audience FROM ipy_campaign WHERE id = $1`,
    [id],
  );
  if (!row) throw new NotFoundError('No such campaign.');
  return { status: row.status, moduleName: row.module_name, audience: row.audience ?? {} };
}

export async function listCampaigns(): Promise<CampaignRow[]> {
  const { rows } = await db.query<{
    id: string; name: string; module_name: string; template_id: string; template_name: string;
    status: CampaignRow['status']; audience: Audience; approved_count: number | null;
    approved_at: string | null; created_at: string;
    pending: string; sent: string; failed: string; skipped: string;
  }>(
    `SELECT c.id, c.name, c.module_name, c.template_id, t.name AS template_name,
            c.status, c.audience, c.approved_count, c.approved_at, c.created_at,
            COUNT(*) FILTER (WHERE r.status = 'pending') AS pending,
            COUNT(*) FILTER (WHERE r.status = 'sent')    AS sent,
            COUNT(*) FILTER (WHERE r.status = 'failed')  AS failed,
            COUNT(*) FILTER (WHERE r.status = 'skipped') AS skipped
       FROM ipy_campaign c
       JOIN ipy_whatsapp_template t ON t.id = c.template_id
       LEFT JOIN ipy_campaign_recipient r ON r.campaign_id = c.id
      GROUP BY c.id, t.name
      ORDER BY c.created_at DESC
      LIMIT 100`,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    moduleName: row.module_name,
    templateId: row.template_id,
    templateName: row.template_name,
    status: row.status,
    audience: row.audience ?? {},
    approvedCount: row.approved_count,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    counts: {
      pending: Number(row.pending), sent: Number(row.sent),
      failed: Number(row.failed), skipped: Number(row.skipped),
    },
  }));
}

export async function createCampaign(input: {
  name: string; module: string; templateId: string; audience: Audience; userId: string;
}): Promise<{ id: string }> {
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_campaign (name, module_name, template_id, audience, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`,
    [input.name, input.module, input.templateId, JSON.stringify(input.audience ?? {}), input.userId],
  );
  return { id: row!.id };
}

/** Who got it, who did not and why — the campaign's own record of itself. */
export async function campaignRecipients(campaignId: string, status?: string): Promise<{
  recordId: string; label: string; handle: string; status: string; error: string | null; sentAt: string | null;
}[]> {
  const { rows } = await db.query<{
    record_id: string; label: string; handle: string; status: string; error: string | null; sent_at: string | null;
  }>(
    `SELECT r.record_id, rec.label, r.handle, r.status, r.error, r.sent_at
       FROM ipy_campaign_recipient r
       JOIN ipy_record rec ON rec.id = r.record_id
      WHERE r.campaign_id = $1 ${status ? 'AND r.status = $2' : ''}
      ORDER BY r.status, rec.label
      LIMIT 500`,
    status ? [campaignId, status] : [campaignId],
  );
  return rows.map((row) => ({
    recordId: row.record_id, label: row.label, handle: row.handle,
    status: row.status, error: row.error, sentAt: row.sent_at,
  }));
}

/*
  Its own clock, slow on purpose.

  Ten messages a minute is not a throughput decision, it is a safety one: a
  campaign approved by mistake has a minute in which somebody can press Pause
  and only ten people have heard about it. Draining five thousand as fast as
  the provider would accept them removes that minute entirely, and no BSP
  thanks a number that sends a thousand templates in ten seconds either.

  One visit at a time, like the inbound poller: two drains reading the same
  pending rows would both try to send them, and the unique index would save
  the customer while the second visit wasted its work.
*/
const SEND_EVERY_MS = 60_000;
let timer: NodeJS.Timeout | null = null;
let sending = false;

export function startCampaignSending(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (sending) return;
    sending = true;
    void sendCampaignBatch()
      .then((result) => {
        if (result.sent || result.failed) logger.info(result, 'campaign batch sent');
      })
      .catch((err) => logger.warn({ err }, 'campaign batch failed'))
      .finally(() => { sending = false; });
  }, SEND_EVERY_MS);
  // Never hold the process open for a campaign; the API shutting down matters more.
  timer.unref?.();
}

export function stopCampaignSending(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
