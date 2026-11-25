import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { getScope, getUser, requireAuth } from '../../middleware/auth.js';
import { ForbiddenError, NotFoundError } from '../../utils/errors.js';
import { assertCapability } from '../../core/permissions/index.js';
import { suggestReplies, draftMessage } from '../../ai/drafting.js';
import { redactAutomated } from '../../integrations/whatsapp/business/channelRoles.js';
import { recordService } from '../../core/entity/recordService.js';

export const commsRouter = Router();
commsRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

commsRouter.get('/conversations', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const { status, assigned, channel, search, recordId, recordModule, limit, offset } = z.object({
    status: z.enum(['open', 'pending', 'resolved', 'snoozed', 'all']).default('open'),
    assigned: z.enum(['me', 'unassigned', 'all']).default('all'),
    channel: z.string().optional(),
    search: z.string().optional(),
    recordId: z.string().uuid().optional(),
    recordModule: z.string().optional(),
    limit: z.coerce.number().int().max(100).default(40),
    offset: z.coerce.number().int().default(0),
  }).parse(req.query);

  const clauses: string[] = [];
  const params: unknown[] = [];

  if (status !== 'all') { params.push(status); clauses.push(`c.status = $${params.length}`); }
  if (channel) { params.push(channel); clauses.push(`c.channel = $${params.length}`); }
  if (recordId) { params.push(recordId); clauses.push(`c.record_id = $${params.length}`); }
  if (recordModule) { params.push(recordModule); clauses.push(`c.record_module = $${params.length}`); }
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
            m.status, m.error_message, m.is_ai_generated, m.created_at, m.delivered_at, m.read_at, m.provider,
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
    messages: redactAutomated(messages.rows, getUser(req).isAdmin),
  });
}));

// WhatsApp sending was removed on 17 September 2026 on the owner's
// instruction, and with it the two routes that posted a message into a
// conversation. The Inbox still reads every thread. See CLAUDE.md.

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
  const { featureOn } = await import('../../core/settings/aiFeatures.js');
  if (!await featureOn('replySuggestions')) {
    // Empty rather than an error: the Inbox asks for these on its own now, and
    // a switched-off feature should be silent rather than a red toast on every
    // incoming message.
    res.json({ suggestions: [] });
    return;
  }
  const user = getUser(req);
  res.json({ suggestions: await suggestReplies(req.params.id, user.id) });
}));

/** Draft a message from the record context. */
commsRouter.post('/draft', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const input = z.object({
    channel: z.enum(['email', 'sms', 'call_script']).default('sms'),
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
