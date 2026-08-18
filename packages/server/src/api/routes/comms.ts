import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { toInternational } from '@ipropy/shared';
import { withNameParts } from '../../core/entity/nameParts.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { getScope, getUser, requireAuth } from '../../middleware/auth.js';
import { ForbiddenError, NotFoundError } from '../../utils/errors.js';
import { assertCapability } from '../../core/permissions/index.js';
import * as wa from '../../integrations/whatsapp/service.js';
import * as waProvider from '../../integrations/whatsapp/provider.js';
import { sendEmail, sendTemplatedEmail, verifyConnection } from '../../integrations/email/service.js';
import { suggestReplies, draftMessage } from '../../ai/drafting.js';
import { notify } from '../../core/notifications/index.js';

export const commsRouter = Router();
commsRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

commsRouter.get('/conversations', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const { status, assigned, channel, search, limit, offset } = z.object({
    status: z.enum(['open', 'pending', 'resolved', 'snoozed', 'all']).default('open'),
    assigned: z.enum(['me', 'unassigned', 'all']).default('all'),
    channel: z.string().optional(),
    search: z.string().optional(),
    limit: z.coerce.number().int().max(100).default(40),
    offset: z.coerce.number().int().default(0),
  }).parse(req.query);

  const clauses: string[] = [];
  const params: unknown[] = [];

  if (status !== 'all') { params.push(status); clauses.push(`c.status = $${params.length}`); }
  if (channel) { params.push(channel); clauses.push(`c.channel = $${params.length}`); }
  if (assigned === 'me') { params.push(user.id); clauses.push(`c.assigned_to = $${params.length}`); }
  else if (assigned === 'unassigned') clauses.push(`c.assigned_to IS NULL`);
  if (search) {
    params.push(`%${search}%`);
    clauses.push(`(c.contact_name ILIKE $${params.length} OR c.handle ILIKE $${params.length})`);
  }
  // Non-admins see their own threads plus anything unassigned.
  if (!user.isAdmin) {
    params.push(user.id);
    clauses.push(`(c.assigned_to = $${params.length} OR c.assigned_to IS NULL)`);
  }
  params.push(limit, offset);

  const rows = await db.query(
    // A conversation outlives the lead: it is keyed by phone number and the
    // messages really were exchanged, so deleting a duplicate lead must not
    // erase the thread. What must go is the *link* — the row used to keep
    // offering "Open lead" for a record that no longer exists, which lands on
    // a 404 and reads as the CRM having lost it. The join condition nulls both
    // the id and the label together, so the UI falls back to the number.
    `SELECT c.id, c.channel, c.handle, c.contact_name,
            r.id AS record_id, CASE WHEN r.id IS NULL THEN NULL ELSE c.record_module END AS record_module,
            c.assigned_to, c.status, c.unread_count, c.last_message_at, c.last_message_preview,
            c.window_expires_at, c.ai_auto_reply, c.sentiment, c.ai_intent, c.ai_summary, c.created_at,
            r.label AS record_label,
            trim(u.first_name || ' ' || u.last_name) AS assigned_name
     FROM ipy_conversation c
     LEFT JOIN ipy_record r ON r.id = c.record_id AND r.is_deleted = false
     LEFT JOIN ipy_user u ON u.id = c.assigned_to
     ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY c.last_message_at DESC NULLS LAST
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  res.json(rows.rows.map((c) => ({
    ...c,
    windowOpen: Boolean(c.window_expires_at && new Date(String(c.window_expires_at)) > new Date()),
  })));
}));

commsRouter.get('/conversations/:id', asyncHandler(async (req, res) => {
  const conv = await db.queryOne(
    // Same treatment as the list: `c.*` would carry the dangling record_id, so
    // the deleted case is overridden after it.
    `SELECT c.*,
            r.id AS record_id, CASE WHEN r.id IS NULL THEN NULL ELSE c.record_module END AS record_module,
            r.label AS record_label,
            trim(u.first_name || ' ' || u.last_name) AS assigned_name
     FROM ipy_conversation c
     LEFT JOIN ipy_record r ON r.id = c.record_id AND r.is_deleted = false
     LEFT JOIN ipy_user u ON u.id = c.assigned_to
     WHERE c.id = $1`,
    [req.params.id],
  );
  if (!conv) throw new NotFoundError('Conversation not found');

  const messages = await db.query(
    `SELECT m.id, m.direction, m.channel, m.type, m.body, m.media, m.template_name,
            m.status, m.error_message, m.is_ai_generated, m.created_at, m.delivered_at, m.read_at,
            trim(u.first_name || ' ' || u.last_name) AS sent_by_name
     FROM ipy_message m LEFT JOIN ipy_user u ON u.id = m.sent_by
     WHERE m.conversation_id = $1
     ORDER BY m.created_at ASC
     LIMIT 300`,
    [req.params.id],
  );

  await db.query(`UPDATE ipy_conversation SET unread_count = 0 WHERE id = $1`, [req.params.id]);

  const expires = (conv as { window_expires_at?: string | null }).window_expires_at;
  const windowOpen = Boolean(expires && new Date(expires) > new Date());


  res.json({
    ...conv,
    windowOpen,
    messages: messages.rows,
  });
}));

const sendSchema = z.object({
  text: z.string().max(4096).optional(),
  templateName: z.string().optional(),
  templateParams: z.record(z.string()).optional(),
  media: z.object({
    type: z.enum(['image', 'document', 'audio', 'video']),
    link: z.string().url(),
    caption: z.string().optional(),
    filename: z.string().optional(),
  }).optional(),
  buttons: z.array(z.object({ id: z.string(), title: z.string().max(20) })).max(3).optional(),
  isAiGenerated: z.boolean().optional(),
});

commsRouter.post('/conversations/:id/messages', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'whatsapp.send');
  const input = sendSchema.parse(req.body);

  const result = await wa.sendMessage({
    conversationId: req.params.id,
    ...input,
    sentBy: user.id,
  });
  res.status(201).json(result);
}));

/** Start a thread from a record's detail page. */
commsRouter.post('/messages', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'whatsapp.send');
  const input = sendSchema.extend({ to: z.string().min(6) }).parse(req.body);

  const result = await wa.sendMessage({ ...input, sentBy: user.id });
  res.status(201).json(result);
}));

commsRouter.patch('/conversations/:id', asyncHandler(async (req, res) => {
  const input = z.object({
    status: z.enum(['open', 'pending', 'resolved', 'snoozed']).optional(),
    assignedTo: z.string().uuid().nullable().optional(),
    aiAutoReply: z.boolean().optional(),
    recordId: z.string().uuid().nullable().optional(),
    recordModule: z.string().nullable().optional(),
    snoozedUntil: z.string().datetime().nullable().optional(),
  }).parse(req.body);

  const map: Record<string, string> = {
    status: 'status', assignedTo: 'assigned_to', aiAutoReply: 'ai_auto_reply',
    recordId: 'record_id', recordModule: 'record_module', snoozedUntil: 'snoozed_until',
  };
  const sets: string[] = [];
  const params: unknown[] = [req.params.id];
  for (const [k, v] of Object.entries(input)) {
    const col = map[k];
    if (!col) continue;
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  }
  if (sets.length) {
    await db.query(`UPDATE ipy_conversation SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
  }
  res.json({ ok: true });
}));

/** AI-suggested quick replies for the composer. */
commsRouter.get('/conversations/:id/suggestions', asyncHandler(async (req, res) => {
  const user = getUser(req);
  res.json({ suggestions: await suggestReplies(req.params.id, user.id) });
}));

/** Draft a message from the record context. */
commsRouter.post('/draft', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const input = z.object({
    channel: z.enum(['whatsapp', 'email', 'sms', 'call_script']).default('whatsapp'),
    recordId: z.string().uuid(),
    module: z.string(),
    goal: z.string().optional(),
    tone: z.enum(['warm', 'professional', 'urgent', 'consultative']).optional(),
    replyingTo: z.string().optional(),
    language: z.string().optional(),
    includeProperties: z.boolean().optional(),
  }).parse(req.body);

  const draft = await draftMessage({ ...input, userId: user.id });
  if (!draft) throw new NotFoundError('Could not generate a draft — check that the AI key is configured');
  res.json(draft);
}));

// ---------------------------------------------------------------------------
// WhatsApp templates
// ---------------------------------------------------------------------------

commsRouter.get('/templates', asyncHandler(async (_req, res) => {
  const rows = await db.query(
    `SELECT id, name, language, category, status, header_format, header_text,
            body_text, footer_text, buttons, variable_map, usage_count
     FROM ipy_whatsapp_template ORDER BY name`,
  );
  res.json(rows.rows);
}));

commsRouter.post('/templates', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'whatsapp.templates');
  const input = z.object({
    name: z.string().regex(/^[a-z0-9_]+$/, 'Use lower case letters, numbers and underscores'),
    language: z.string().default('en'),
    category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']).default('UTILITY'),
    headerText: z.string().nullable().optional(),
    headerFormat: z.enum(['TEXT', 'IMAGE', 'DOCUMENT', 'VIDEO']).nullable().optional(),
    bodyText: z.string().min(1),
    footerText: z.string().nullable().optional(),
    buttons: z.array(z.record(z.unknown())).default([]),
    variableMap: z.record(z.string()).default({}),
  }).parse(req.body);

  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_whatsapp_template
      (name, language, category, header_format, header_text, body_text, footer_text, buttons, variable_map, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (name, language) DO UPDATE SET
       category = EXCLUDED.category, header_text = EXCLUDED.header_text,
       body_text = EXCLUDED.body_text, footer_text = EXCLUDED.footer_text,
       buttons = EXCLUDED.buttons, variable_map = EXCLUDED.variable_map
     RETURNING id`,
    [
      input.name, input.language, input.category, input.headerFormat ?? null, input.headerText ?? null,
      input.bodyText, input.footerText ?? null, JSON.stringify(input.buttons),
      JSON.stringify(input.variableMap), getUser(req).id,
    ],
  );
  res.status(201).json({ id: row?.id });
}));

commsRouter.post('/templates/sync', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'whatsapp.templates');
  res.json(await waProvider.syncTemplates());
}));

commsRouter.delete('/templates/:id', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'whatsapp.templates');
  await db.query(`DELETE FROM ipy_whatsapp_template WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Broadcast (bulk template sends)
// ---------------------------------------------------------------------------

commsRouter.post('/broadcast', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'whatsapp.send');
  const input = z.object({
    templateName: z.string(),
    module: z.string(),
    recordIds: z.array(z.string().uuid()).min(1).max(2000),
    ratePerSecond: z.number().min(1).max(50).default(10),
  }).parse(req.body);

  const scope = getScope(req);
  const { registry } = await import('../../core/metadata/registry.js');
  const meta = await registry.requireModule(input.module);

  // Resolve each recipient's number and merge params from the record itself.
  const recipients: { handle: string; params: Record<string, string>; recordId: string }[] = [];
  for (const recordId of input.recordIds) {
    const row = await db.queryOne<Record<string, unknown>>(
      `SELECT r.label, e.* FROM ipy_record r JOIN ${meta.tableName} e ON e.record_id = r.id WHERE r.id = $1`,
      [recordId],
    );
    if (!row) continue;
    const handle = toInternational(
      String(row.country_code ?? ''),
      String(row.whatsapp_number ?? row.mobile ?? ''),
    ) ?? '';
    if (!handle) continue;
    if (row.do_not_whatsapp === true) continue;

    const params = await wa.bindTemplateParams(input.templateName, withNameParts(row));
    recipients.push({ handle, params, recordId });
  }

  // Respond immediately; the send runs in the background at the given rate.
  res.status(202).json({ queued: recipients.length, skipped: input.recordIds.length - recipients.length });

  void wa.broadcast({
    templateName: input.templateName,
    recipients,
    sentBy: user.id,
    ratePerSecond: input.ratePerSecond,
  }).then(async (result) => {
    // The whole point of answering 202 is that you can walk away, so the result
    // has to find you rather than wait in a tab you closed.
    await notify({
      userId: user.id,
      kind: 'broadcast',
      title: 'Broadcast complete',
      body: `${result.sent} sent, ${result.failed} failed.`,
    });
  }).catch(() => undefined);
}));

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

commsRouter.post('/email', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const input = z.object({
    to: z.union([z.string().email(), z.array(z.string().email())]),
    cc: z.array(z.string().email()).optional(),
    subject: z.string().min(1),
    html: z.string().min(1),
    recordId: z.string().uuid().nullable().optional(),
  }).parse(req.body);

  res.json(await sendEmail({ ...input, recordId: input.recordId ?? null, sentBy: user.id }));
}));

commsRouter.post('/email/template', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const input = z.object({
    to: z.union([z.string().email(), z.array(z.string().email())]),
    templateName: z.string(),
    recordId: z.string().uuid(),
    module: z.string(),
  }).parse(req.body);

  const { buildRecordSummary } = await import('../../ai/drafting.js');
  const { registry } = await import('../../core/metadata/registry.js');
  const meta = await registry.requireModule(input.module);

  const row = await db.queryOne<Record<string, unknown>>(
    `SELECT r.label, e.* FROM ipy_record r JOIN ${meta.tableName} e ON e.record_id = r.id WHERE r.id = $1`,
    [input.recordId],
  );

  res.json(await sendTemplatedEmail({
    to: input.to,
    templateName: input.templateName,
    recordId: input.recordId,
    sentBy: user.id,
    scope: {
      record: row ?? {},
      contact: row ?? {},
      owner: { full_name: user.fullName, phone: user.phone, email: user.email },
      summary: await buildRecordSummary(input.recordId, input.module),
    },
  }));
}));

commsRouter.get('/email/templates', asyncHandler(async (_req, res) => {
  const rows = await db.query(
    `SELECT t.id, t.name, t.subject, t.body_html, t.category, t.is_active, m.name AS module
     FROM ipy_email_template t LEFT JOIN ipy_module m ON m.id = t.module_id
     WHERE t.is_active ORDER BY t.name`,
  );
  res.json(rows.rows);
}));

commsRouter.get('/email/status', asyncHandler(async (req, res) => {
  if (!getUser(req).isAdmin) throw new ForbiddenError();
  res.json(await verifyConnection());
}));
