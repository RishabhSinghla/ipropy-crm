/**
 * Conversation service — the CRM-side model of WhatsApp.
 *
 * Handles thread resolution (which lead/contact does this number belong to?),
 * the 24-hour customer-service window, template variable binding, and pushing
 * everything onto the record timeline.
 */
import { renderTemplate, toE164 } from '@ipropy/shared';
import { db, onCommit, transaction, type Tx } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { BadRequestError, NotFoundError } from '../../utils/errors.js';
import { bus } from '../../core/events/bus.js';
import { touchActivity } from '../../core/entity/recordService.js';
import { notify } from '../../core/notifications/index.js';
import * as provider from './provider.js';
import { detectConsentKeyword, maySend, recordConsent } from './consent.js';
import { runAutoReply } from './autoreply.js';
import { exitAllForHandle } from './sequences.js';

const WINDOW_HOURS = 24;

export interface ResolvedContact {
  recordId: string | null;
  module: string | null;
  name: string | null;
  ownerId: string | null;
}

/**
 * Find which CRM record a phone number belongs to. Checks contacts first
 * (a known customer outranks an old lead), then leads, then channel partners.
 */
export async function resolveHandle(handle: string, conn: Tx = db): Promise<ResolvedContact> {
  const e164 = toE164(handle) ?? handle;
  const digits = e164.replace(/\D/g, '');
  // Match on the last 10 digits so +91/0/no-prefix variants all resolve.
  const tail = digits.slice(-10);

  // Customers outrank channel partners when a number matches both, and a more
  // advanced lifecycle stage wins over an older enquiry.
  const row = await conn.queryOne<{ record_id: string; module_name: string; label: string; owner_id: string | null }>(
    `SELECT record_id, module_name, label, owner_id FROM (
       SELECT r.id AS record_id, r.module_name, r.label, r.owner_id,
              CASE l.lifecycle_stage WHEN 'Customer' THEN 0 WHEN 'Prospect' THEN 1 ELSE 2 END AS rank,
              r.updated_at
       FROM ipy_e_leads l JOIN ipy_record r ON r.id = l.record_id
       WHERE r.is_deleted = false
         AND (right(regexp_replace(COALESCE(l.whatsapp_number,''), '\\D', '', 'g'), 10) = $1
           OR right(regexp_replace(COALESCE(l.mobile,''), '\\D', '', 'g'), 10) = $1)
     ) matches
     ORDER BY rank, updated_at DESC
     LIMIT 1`,
    [tail],
  );

  if (!row) return { recordId: null, module: null, name: null, ownerId: null };
  return { recordId: row.record_id, module: row.module_name, name: row.label, ownerId: row.owner_id };
}

export async function getOrCreateConversation(
  handle: string,
  channel: 'whatsapp' | 'sms' | 'email' | 'webchat' = 'whatsapp',
  conn: Tx = db,
): Promise<string> {
  const e164 = toE164(handle) ?? handle;

  const existing = await conn.queryOne<{ id: string }>(
    `SELECT id FROM ipy_conversation WHERE channel = $1 AND handle = $2`, [channel, e164],
  );
  if (existing) return existing.id;

  const resolved = await resolveHandle(e164, conn);
  const row = await conn.queryOne<{ id: string }>(
    `INSERT INTO ipy_conversation (channel, handle, contact_name, record_id, record_module, assigned_to)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (channel, handle) DO UPDATE SET handle = EXCLUDED.handle
     RETURNING id`,
    [channel, e164, resolved.name, resolved.recordId, resolved.module, resolved.ownerId],
  );
  return row!.id;
}

/** True when free-form (non-template) messages are still allowed. */
export async function isWindowOpen(conversationId: string, conn: Tx = db): Promise<boolean> {
  const row = await conn.queryOne<{ window_expires_at: string | null }>(
    `SELECT window_expires_at FROM ipy_conversation WHERE id = $1`, [conversationId],
  );
  return Boolean(row?.window_expires_at && new Date(row.window_expires_at) > new Date());
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

export interface InboundMessage {
  from: string;
  providerMessageId: string;
  type: string;
  text?: string;
  mediaId?: string;
  mimeType?: string;
  caption?: string;
  filename?: string;
  /** interactive button reply */
  buttonPayload?: string;
  location?: { latitude: number; longitude: number; name?: string };
  timestamp?: number;
  profileName?: string;
}

export async function handleInbound(msg: InboundMessage): Promise<{ conversationId: string; messageId: string }> {
  return transaction(async (tx) => {
    const conversationId = await getOrCreateConversation(msg.from, 'whatsapp', tx);
    const now = msg.timestamp ? new Date(msg.timestamp * 1000) : new Date();

    let media: Record<string, unknown> | null = null;
    if (msg.mediaId) {
      const resolved = await provider.fetchMediaUrl(msg.mediaId);
      media = {
        url: resolved?.url ?? null,
        mimeType: resolved?.mimeType ?? msg.mimeType ?? 'application/octet-stream',
        fileName: msg.filename,
        caption: msg.caption,
        providerMediaId: msg.mediaId,
      };
    }
    if (msg.location) {
      media = { location: msg.location, mimeType: 'application/geo+json' };
    }

    const body = msg.text ?? msg.buttonPayload ?? msg.caption
      ?? (msg.location ? `📍 ${msg.location.name ?? `${msg.location.latitude}, ${msg.location.longitude}`}` : null);

    const message = await tx.queryOne<{ id: string }>(
      `INSERT INTO ipy_message
        (conversation_id, direction, channel, type, body, media, status, provider_message_id, provider, created_at, delivered_at)
       VALUES ($1,'inbound','whatsapp',$2,$3,$4,'delivered',$5,'meta',$6,$6)
       RETURNING id`,
      [conversationId, msg.type, body, media ? JSON.stringify(media) : null, msg.providerMessageId, now],
    );
    const inboundCount = await tx.queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM ipy_message
       WHERE conversation_id = $1 AND direction = 'inbound'`,
      [conversationId],
    );

    // An inbound message re-opens the 24h free-form window.
    await tx.query(
      `UPDATE ipy_conversation
       SET last_message_at = $2, last_inbound_at = $2, last_message_preview = $3,
           unread_count = unread_count + 1, window_expires_at = $2 + interval '${WINDOW_HOURS} hours',
           status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END,
           contact_name = COALESCE(contact_name, $4),
           updated_at = now()
       WHERE id = $1`,
      [conversationId, now, (body ?? `[${msg.type}]`).slice(0, 200), msg.profileName ?? null],
    );

    const conv = await tx.queryOne<{ record_id: string | null; record_module: string | null; ai_auto_reply: boolean; assigned_to: string | null }>(
      `SELECT record_id, record_module, ai_auto_reply, assigned_to FROM ipy_conversation WHERE id = $1`,
      [conversationId],
    );

    if (conv?.record_id) {
      await touchActivity(conv.record_id, tx);
      // First inbound reply satisfies the SLA.
      await tx.query(
        `UPDATE ipy_sla_tracker SET first_response_at = COALESCE(first_response_at, now())
         WHERE record_id = $1 AND first_response_at IS NULL`,
        [conv.record_id],
      );
    }

    if (conv?.assigned_to) {
      await notify({
        userId: conv.assigned_to,
        kind: 'whatsapp',
        title: `New WhatsApp from ${msg.profileName ?? msg.from}`,
        body: (body ?? '').slice(0, 200),
        link: `/inbox/${conversationId}`,
        recordId: conv.record_id,
      }, tx);
    }

    bus.emitAsync('message.received', {
      conversationId,
      messageId: message!.id,
      direction: 'inbound',
      channel: 'whatsapp',
      body,
      handle: msg.from,
      recordId: conv?.record_id ?? null,
    });

    // STOP / START. Handled before anything else can reply, and inside this
    // transaction, so a person who opts out cannot receive an auto-reply in
    // the same breath.
    const consentAction = detectConsentKeyword(body);
    if (consentAction) {
      await recordConsent({
        handle: msg.from, action: consentAction, source: 'keyword',
        messageText: body, recordId: conv?.record_id ?? null,
      }, tx);
    }

    // Auto-reply runs after commit: it sends a message, and doing that inside
    // an open transaction risks holding a row lock across a network call to
    // Meta (see CLAUDE.md on emitting inside transactions).
    onCommit(tx, async () => {
      // Someone who replies is now in a conversation with a person. Any drip
      // sequence still aimed at them has to stop before the next scheduler
      // tick, or they get a canned follow-up on top of a live exchange — the
      // single most common way marketing automation reads as spam.
      await exitAllForHandle(msg.from, 'Replied on WhatsApp')
        .catch((err) => logger.warn({ err }, 'could not exit sequences on reply'));

      await runAutoReply({
        conversationId,
        handle: msg.from,
        text: body,
        recordId: conv?.record_id ?? null,
        consentAction,
        buttonPayload: msg.buttonPayload ?? null,
        isFirstMessage: inboundCount?.count === 1,
      }).catch((err) => logger.warn({ err }, 'auto-reply failed'));
    });

    return { conversationId, messageId: message!.id };
  });
}

/** Provider delivery/read receipts. */
export async function handleStatusUpdate(
  providerMessageId: string,
  status: string,
  timestamp?: number,
): Promise<void> {
  const mapped = ['sent', 'delivered', 'read', 'failed'].includes(status) ? status : null;
  if (!mapped) return;
  const at = timestamp ? new Date(timestamp * 1000) : new Date();
  await db.query(
    `UPDATE ipy_message
     SET status = $2,
         delivered_at = CASE WHEN $2 IN ('delivered','read') THEN COALESCE(delivered_at, $3) ELSE delivered_at END,
         read_at = CASE WHEN $2 = 'read' THEN COALESCE(read_at, $3) ELSE read_at END
     WHERE provider_message_id = $1`,
    [providerMessageId, mapped, at],
  );
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

export interface SendMessageInput {
  conversationId?: string;
  to?: string;
  text?: string;
  templateName?: string;
  templateParams?: Record<string, string>;
  media?: { type: 'image' | 'document' | 'audio' | 'video'; link: string; caption?: string; filename?: string };
  buttons?: { id: string; title: string }[];
  sentBy?: string | null;
  isAiGenerated?: boolean;
  workflowId?: string | null;
  /**
   * Part of a bulk send rather than a reply somebody typed.
   *
   * Only consent reads it, and it has to be explicit: a broadcast dropping into
   * a conversation that happens to be inside the 24-hour window is still
   * marketing, and treating it as a session reply would let it past an opt-out.
   */
  isBroadcast?: boolean;
}

export async function sendMessage(input: SendMessageInput): Promise<{ messageId: string; status: string; error?: string }> {
  const handle = input.to
    ? toE164(input.to)
    : (await db.queryOne<{ handle: string }>(`SELECT handle FROM ipy_conversation WHERE id = $1`, [input.conversationId!]))?.handle;
  if (!handle) throw new BadRequestError('No recipient number for this message');

  const conversationId = input.conversationId ?? await getOrCreateConversation(handle);

  // Outside the 24h window Meta only accepts templates — surface that clearly
  // rather than letting the API reject it with a cryptic error.
  const windowOpen = await isWindowOpen(conversationId);

  // Consent is enforced here, on the one path every send goes through, rather
  // than trusted to whoever built the audience. Meta penalises the *number*
  // for messaging people who opted out, and the number is the whole channel.
  // Replying inside an open session is exempt: they messaged us, and declining
  // to answer a live question is not what opting out of marketing means.
  const consent = await maySend(handle, { sessionReply: windowOpen && !input.templateName && !input.isBroadcast });
  if (!consent.allowed) {
    const blocked = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_message (conversation_id, direction, channel, type, body, status, error, sent_by)
       VALUES ($1,'outbound','whatsapp','text',$2,'blocked',$3,$4) RETURNING id`,
      [conversationId, input.text ?? input.templateName ?? null, consent.reason, input.sentBy ?? null],
    );
    // Logged rather than thrown: a broadcast must skip this recipient and carry
    // on, and the operator needs to see that it was skipped and why.
    return { messageId: blocked?.id ?? '', status: 'blocked', error: consent.reason };
  }
  if (!windowOpen && !input.templateName && !input.media) {
    throw new BadRequestError(
      'This conversation is outside the 24-hour WhatsApp window. Send an approved template to re-open it.',
      { requiresTemplate: true },
    );
  }

  let result: provider.SendResult;
  let type: string = 'text';
  let body: string | null = input.text ?? null;

  if (input.templateName) {
    const template = await db.queryOne<{
      body_text: string; header_text: string | null; header_format: string | null;
      language: string; variable_map: Record<string, string>; buttons: { type: string; url?: string }[];
    }>(
      `SELECT body_text, header_text, header_format, language, variable_map, buttons
       FROM ipy_whatsapp_template WHERE name = $1 ORDER BY (status = 'APPROVED') DESC LIMIT 1`,
      [input.templateName],
    );
    if (!template) throw new NotFoundError(`Unknown WhatsApp template '${input.templateName}'`);

    const params = input.templateParams ?? {};
    const ordered = Object.keys(template.variable_map ?? {})
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => params[k] ?? '');

    result = await provider.sendTemplate({
      to: handle,
      templateName: input.templateName,
      language: template.language,
      bodyParams: ordered,
      headerParam: template.header_text ? renderTemplate(template.header_text, params) : undefined,
      headerType: (template.header_format?.toLowerCase() as 'text' | 'image' | undefined) ?? 'text',
    });
    type = 'template';
    // Store the rendered text so the timeline shows what the customer saw.
    body = substituteNumbered(template.body_text, ordered);
    await db.query(`UPDATE ipy_whatsapp_template SET usage_count = usage_count + 1 WHERE name = $1`, [input.templateName]);
  } else if (input.media) {
    result = await provider.sendMedia({ to: handle, ...input.media });
    type = input.media.type;
    body = input.media.caption ?? null;
  } else if (input.buttons?.length) {
    result = await provider.sendInteractive({
      to: handle,
      bodyText: input.text ?? '',
      buttons: input.buttons,
    });
    type = 'interactive';
  } else {
    result = await provider.sendText({ to: handle, text: input.text ?? '' });
  }

  const message = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_message
      (conversation_id, direction, channel, type, body, template_name, template_params,
       status, error_message, provider_message_id, provider, sent_by, is_ai_generated,
       workflow_id, sent_via)
     VALUES ($1,'outbound','whatsapp',$2,$3,$4,$5,$6,$7,$8,'meta',$9,$10,$11,'api')
     RETURNING id`,
    [
      conversationId, type, body,
      input.templateName ?? null,
      input.templateParams ? JSON.stringify(input.templateParams) : null,
      result.status, result.error ?? null, result.providerMessageId,
      input.sentBy ?? null, input.isAiGenerated ?? false,
      input.workflowId ?? null,
    ],
  );

  await db.query(
    `UPDATE ipy_conversation SET last_message_at = now(), last_message_preview = $2, updated_at = now() WHERE id = $1`,
    [conversationId, (body ?? `[${type}]`).slice(0, 200)],
  );

  const conv = await db.queryOne<{ record_id: string | null }>(
    `SELECT record_id FROM ipy_conversation WHERE id = $1`, [conversationId],
  );
  if (conv?.record_id) await touchActivity(conv.record_id);

  bus.emitAsync('message.sent', {
    conversationId,
    messageId: message!.id,
    direction: 'outbound',
    channel: 'whatsapp',
    body,
    handle,
    recordId: conv?.record_id ?? null,
  });

  if (result.status === 'failed') {
    logger.warn({ handle, error: result.error }, 'whatsapp message failed');
  }

  return { messageId: message!.id, status: result.status, error: result.error };
}

function substituteNumbered(text: string, params: string[]): string {
  return text.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => params[Number(n) - 1] ?? '');
}

// ---------------------------------------------------------------------------
// Workflow bridge
// ---------------------------------------------------------------------------

export interface WorkflowSendInput {
  to: string;
  templateName?: string;
  fallbackText?: string;
  useAiDraft?: boolean;
  recordId: string;
  module: string;
  scope: Record<string, unknown>;
  workflowId?: string;
}

/**
 * Called by the send_whatsapp workflow task. Binds the template's variable map
 * against the record's merge scope, and can ask the AI to draft the message.
 */
export async function sendWhatsAppForWorkflow(input: WorkflowSendInput): Promise<void> {
  let text = input.fallbackText;

  if (input.useAiDraft) {
    try {
      const { draftMessage } = await import('../../ai/drafting.js');
      const draft = await draftMessage({
        channel: 'whatsapp',
        recordId: input.recordId,
        module: input.module,
        goal: 'Re-engage this contact with a short, specific, non-pushy message.',
      });
      if (draft?.body) text = draft.body;
    } catch (err) {
      logger.warn({ err }, 'AI draft failed; falling back to the configured text');
    }
  }

  // No Business API? Queue it for a human to send from their own WhatsApp.
  //
  // Without this the whole instant-response workflow is theatre: it fires, the
  // send finds no provider, and nothing reaches the buyer — while the CRM
  // reports the workflow ran. Meta approval takes months and speed to lead is
  // the single biggest conversion lever there is, so the eight months of
  // waiting should not also be eight months of not answering enquiries.
  //
  // One tap instead of none. The message is written, addressed and merged; a
  // person presses send. Everything downstream — the queue, the header badge,
  // the timeline, the lead's last-contacted date — already existed and simply
  // was never fed from here.
  const { isConfigured } = await import('./provider.js');
  if (!(await isConfigured())) {
    // The whole branch is guarded, not just the queue call. A throw anywhere in
    // here propagates out of the workflow task and abandons the rest of the
    // run for that record — so one bad template name stops a lead being
    // scored, tagged and followed up, over a message that was only ever going
    // to be a suggestion. Failing to *offer* a message is not a reason to fail
    // everything else the workflow was going to do.
    try {
      const body = text ?? (input.templateName
        ? await renderedTemplate(input.templateName, input.scope)
        : null);
      if (!body) {
        logger.info({ recordId: input.recordId }, 'whatsapp workflow skipped — no provider and no text to hand a person');
        return;
      }
      const { queueDeviceSend, renderForRecord } = await import('./deviceSend.js');
      await queueDeviceSend({
        handle: input.to,
        body: await renderForRecord(body, input.recordId ?? null, input.module ?? 'leads'),
        recordId: input.recordId ?? null,
        module: input.module ?? 'leads',
        reason: 'Workflow — no WhatsApp Business account connected',
      });
    } catch (err) {
      logger.warn({ err, recordId: input.recordId }, 'could not queue a message for manual sending');
    }
    return;
  }

  const conversationId = await getOrCreateConversation(input.to);
  const windowOpen = await isWindowOpen(conversationId);

  // Inside the window prefer the (free-form) drafted text; outside it we must
  // use an approved template.
  if (windowOpen && text) {
    await sendMessage({
      conversationId, text, isAiGenerated: Boolean(input.useAiDraft),
      workflowId: input.workflowId ?? null,
    });
    return;
  }

  if (!input.templateName) {
    logger.info({ recordId: input.recordId }, 'whatsapp workflow skipped — window closed and no template configured');
    return;
  }

  const params = await bindTemplateParams(input.templateName, input.scope);
  await sendMessage({
    conversationId,
    templateName: input.templateName,
    templateParams: params,
    isAiGenerated: Boolean(input.useAiDraft),
    workflowId: input.workflowId ?? null,
  });
}

/** Resolve a template's {{1}}, {{2}} … from its variable_map against a scope. */
export async function bindTemplateParams(
  templateName: string,
  scope: Record<string, unknown>,
): Promise<Record<string, string>> {
  const template = await db.queryOne<{ variable_map: Record<string, string> }>(
    `SELECT variable_map FROM ipy_whatsapp_template WHERE name = $1 LIMIT 1`, [templateName],
  );
  if (!template?.variable_map) return {};

  const out: Record<string, string> = {};
  for (const [index, path] of Object.entries(template.variable_map)) {
    // Paths look like "record.first_name" or "owner.full_name".
    const cleaned = path.startsWith('record.') ? path.slice(7) : path;
    const value = cleaned.split('.').reduce<unknown>((acc, key) => {
      if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
      return undefined;
    }, scope);
    out[index] = value === null || value === undefined ? '' : String(value);
  }
  return out;
}

/** Bulk send — templates only, rate-limited to stay within tier caps. */
export async function broadcast(input: {
  templateName: string;
  recipients: { handle: string; params: Record<string, string>; recordId?: string }[];
  sentBy?: string;
  ratePerSecond?: number;
}): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  const delayMs = Math.max(0, 1000 / (input.ratePerSecond ?? 10));

  for (const r of input.recipients) {
    try {
      const result = await sendMessage({
        to: r.handle,
        templateName: input.templateName,
        templateParams: r.params,
        isBroadcast: true,
        sentBy: input.sentBy ?? null,
      });
      if (result.status === 'sent') sent++; else failed++;
    } catch (err) {
      failed++;
      logger.warn({ err, handle: r.handle }, 'broadcast recipient failed');
    }
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { sent, failed };
}

/**
 * A template's own text, for when there is no provider to send it through.
 *
 * An approved template is a Meta artefact, but its body is just words with
 * `{{1}}` placeholders in it — perfectly sendable by a human. Falling back to
 * it means a workflow written for the API path still says something useful on
 * the phone path rather than silently doing nothing.
 */
/**
 * An approved template, with its numbered placeholders actually filled in.
 *
 * Meta templates use `{{1}}`, `{{2}}` and a `variable_map` that says what each
 * one means — the API path resolves them through `bindTemplateParams`. The
 * device-send path renders named `{{token}}` merges instead, so handing it a
 * template body raw produced "Hi , just checking in on your home search. We
 * have new inventory in  that fits your budget of ." and queued it for a rep
 * to send to a customer.
 *
 * Bound here, with the same map, before the named-merge pass runs over what is
 * left.
 */
async function renderedTemplate(
  templateName: string,
  scope: Record<string, unknown>,
): Promise<string | null> {
  const body = await templateBody(templateName);
  if (!body) return null;

  const params = await bindTemplateParams(templateName, scope);

  // A placeholder with nothing behind it means this record cannot fill this
  // template, and there is no good way to render that. Leaving the token
  // visible does not survive the named-merge pass that runs afterwards, and
  // blanking it produces "new inventory in  that fits your budget of ." — a
  // sentence that reads finished, which is exactly why a rep sends it.
  //
  // So the message is not offered at all. A nurture template exists to say
  // something specific about this buyer; with the specifics missing it has
  // nothing to say, and silence is the honest version of that. The rest of the
  // workflow — scoring, tagging, the follow-up date — is unaffected.
  const missing = Object.keys(params).filter((index) => !params[index]);
  if (missing.length) {
    logger.info(
      { templateName, missing },
      'template not queued for manual sending — the record cannot fill its placeholders',
    );
    return null;
  }

  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (whole, index: string) => params[index] ?? whole);
}

async function templateBody(templateName: string): Promise<string | null> {
  // `body_text`, not `body`. Getting this wrong threw rather than returning
  // null, and the throw propagated out of the workflow task and abandoned the
  // whole run for that record — so a nurture workflow naming a template and
  // relying on the AI draft failed outright instead of falling back. Caught by
  // running the scheduler against sixty thousand leads; the only workflow
  // exercised before that had its own fallbackText and never reached here.
  const row = await db.queryOne<{ body_text: string | null }>(
    `SELECT body_text FROM ipy_whatsapp_template WHERE name = $1 LIMIT 1`, [templateName],
  );
  return row?.body_text?.trim() || null;
}
