/**
 * Outreach — device sends, broadcasts, drip sequences and auto-reply rules.
 *
 * Split out of `comms.ts`, which is about one conversation at a time. This is
 * the many-people half: the queue a rep works through on their phone, the
 * broadcast that fills it, and the sequences that keep filling it for weeks.
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { getUser, requireAuth } from '../../middleware/auth.js';
import { NotFoundError } from '../../utils/errors.js';
import { assertCapability } from '../../core/permissions/index.js';
import * as device from '../../integrations/whatsapp/deviceSend.js';
import * as broadcasts from '../../integrations/whatsapp/broadcast.js';
import * as sequences from '../../integrations/whatsapp/sequences.js';
import * as waProvider from '../../integrations/whatsapp/provider.js';

export const outreachRouter = Router();
outreachRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// Channel capability
//
// The UI branches on this rather than guessing. Everything downstream is built
// to work in either mode, but the wording changes: "Send" versus "Add to my
// send queue" are different promises and should not look identical.
// ---------------------------------------------------------------------------

outreachRouter.get('/channel', asyncHandler(async (_req, res) => {
  const apiReady = await waProvider.isConfigured();
  res.json({
    apiReady,
    mode: apiReady ? 'api' : 'device',
    message: apiReady
      ? 'WhatsApp Business API is connected. Messages send automatically.'
      : 'No WhatsApp Business account yet — messages are prepared here and sent from your phone in one tap.',
  });
}));

// ---------------------------------------------------------------------------
// Device send queue
// ---------------------------------------------------------------------------

outreachRouter.get('/device-queue', asyncHandler(async (req, res) => {
  const user = getUser(req);
  res.json(await device.listPending(user.id));
}));

/** Compose a link for one record without queueing anything. */
outreachRouter.post('/device-link', asyncHandler(async (req, res) => {
  const input = z.object({
    handle: z.string().min(6),
    body: z.string().min(1).max(1500),
    recordId: z.string().uuid().nullable().optional(),
    module: z.string().default('leads'),
    render: z.boolean().default(true),
  }).parse(req.body);

  const body = input.render
    ? await device.renderForRecord(input.body, input.recordId ?? null, input.module)
    : input.body;

  res.json({ link: device.buildWaLink(input.handle, body), body });
}));

outreachRouter.post('/device-queue', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const input = z.object({
    handle: z.string().min(6),
    body: z.string().min(1),
    recordId: z.string().uuid().nullable().optional(),
    module: z.string().optional(),
    name: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
    assignedTo: z.string().uuid().nullable().optional(),
  }).parse(req.body);

  const result = await device.queueDeviceSend({ ...input, assignedTo: input.assignedTo ?? user.id });
  res.status(result.skipped ? 200 : 201).json(result);
}));

outreachRouter.post('/device-queue/:id/opened', asyncHandler(async (req, res) => {
  await device.markOpened(req.params.id);
  res.json({ ok: true });
}));

outreachRouter.post('/device-queue/:id/sent', asyncHandler(async (req, res) => {
  const user = getUser(req);
  res.json(await device.markSent(req.params.id, user.id));
}));

outreachRouter.post('/device-queue/:id/skip', asyncHandler(async (req, res) => {
  const input = z.object({ reason: z.string().optional() }).parse(req.body ?? {});
  await device.skip(req.params.id, input.reason);
  res.json({ ok: true });
}));

/**
 * Log a message the rep sent straight from a record page, bypassing the queue.
 * Separate from the queue endpoints because there was never a queued row.
 */
outreachRouter.post('/device-sent', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const input = z.object({
    handle: z.string().min(6),
    body: z.string().min(1),
    recordId: z.string().uuid().nullable().optional(),
  }).parse(req.body);

  const messageId = await device.logDeviceMessage({ ...input, sentBy: user.id });
  res.status(201).json({ messageId });
}));

// ---------------------------------------------------------------------------
// Broadcasts
// ---------------------------------------------------------------------------

outreachRouter.get('/broadcasts', asyncHandler(async (_req, res) => {
  const rows = await db.query(
    `SELECT b.id, b.name, b.channel_mode, b.template_name, b.status, b.scheduled_at,
            b.total_count, b.sent_count, b.failed_count, b.blocked_count,
            b.created_at, b.started_at, b.completed_at,
            trim(u.first_name || ' ' || u.last_name) AS created_by_name
     FROM ipy_broadcast b LEFT JOIN ipy_user u ON u.id = b.created_by
     ORDER BY b.created_at DESC LIMIT 100`,
  );
  res.json(rows.rows);
}));

outreachRouter.get('/broadcasts/:id', asyncHandler(async (req, res) => {
  const broadcast = await db.queryOne(`SELECT * FROM ipy_broadcast WHERE id = $1`, [req.params.id]);
  if (!broadcast) throw new NotFoundError('Broadcast not found');

  const recipients = await db.query(
    `SELECT id, record_id, handle, name, status, error, rendered_text, sent_at
     FROM ipy_broadcast_recipient WHERE broadcast_id = $1
     ORDER BY status, name LIMIT 2000`,
    [req.params.id],
  );
  res.json({ ...broadcast, recipients: recipients.rows });
}));

outreachRouter.post('/broadcasts', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'whatsapp.send');
  const input = z.object({
    name: z.string().min(1).max(120),
    channelMode: z.enum(['api', 'device']).default('device'),
    templateName: z.string().nullable().optional(),
    bodyText: z.string().max(1500).nullable().optional(),
    module: z.string().default('leads'),
    recordIds: z.array(z.string().uuid()).min(1).max(5000),
    campaignId: z.string().uuid().nullable().optional(),
    scheduledAt: z.string().datetime().nullable().optional(),
    ratePerSecond: z.number().min(0.5).max(50).default(10),
  }).parse(req.body);

  res.status(201).json(await broadcasts.createBroadcast({ ...input, createdBy: user.id }));
}));

outreachRouter.post('/broadcasts/:id/start', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'whatsapp.send');
  await broadcasts.startBroadcast(req.params.id);
  res.json({ ok: true });
}));

outreachRouter.post('/broadcasts/:id/pause', asyncHandler(async (req, res) => {
  await broadcasts.pauseBroadcast(req.params.id);
  res.json({ ok: true });
}));

outreachRouter.post('/broadcasts/:id/cancel', asyncHandler(async (req, res) => {
  await broadcasts.cancelBroadcast(req.params.id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Sequences
// ---------------------------------------------------------------------------

outreachRouter.get('/sequences', asyncHandler(async (_req, res) => {
  const rows = await db.query(
    `SELECT s.*,
            (SELECT count(*) FROM ipy_sequence_step st WHERE st.sequence_id = s.id AND st.is_active) AS step_count,
            (SELECT count(*) FROM ipy_sequence_enrolment e WHERE e.sequence_id = s.id AND e.status = 'active') AS active_count
     FROM ipy_sequence s ORDER BY s.created_at DESC`,
  );
  res.json(rows.rows);
}));

outreachRouter.get('/sequences/:id', asyncHandler(async (req, res) => {
  const sequence = await db.queryOne(`SELECT * FROM ipy_sequence WHERE id = $1`, [req.params.id]);
  if (!sequence) throw new NotFoundError('Sequence not found');

  const steps = await db.query(
    `SELECT * FROM ipy_sequence_step WHERE sequence_id = $1 ORDER BY sequence`, [req.params.id],
  );
  const enrolments = await db.query(
    `SELECT e.id, e.record_id, e.handle, e.status, e.current_step, e.next_run_at,
            e.exit_reason, e.last_error, r.label
     FROM ipy_sequence_enrolment e LEFT JOIN ipy_record r ON r.id = e.record_id
     WHERE e.sequence_id = $1 ORDER BY e.updated_at DESC LIMIT 500`,
    [req.params.id],
  );
  res.json({ ...sequence, steps: steps.rows, enrolments: enrolments.rows });
}));

const sequenceSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().nullable().optional(),
  isActive: z.boolean().default(false),
  moduleName: z.string().default('leads'),
  enrolTrigger: z.enum(['manual', 'on_create', 'on_condition']).default('manual'),
  enrolFilter: z.record(z.unknown()).default({}),
  exitOnReply: z.boolean().default(true),
  exitOnStatus: z.array(z.string()).default([]),
  quietStart: z.number().int().min(0).max(23).default(21),
  quietEnd: z.number().int().min(0).max(23).default(9),
});

outreachRouter.post('/sequences', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const input = sequenceSchema.parse(req.body);
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_sequence
      (name, description, is_active, module_name, enrol_trigger, enrol_filter,
       exit_on_reply, exit_on_status, quiet_start, quiet_end, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [
      input.name, input.description ?? null, input.isActive, input.moduleName,
      input.enrolTrigger, JSON.stringify(input.enrolFilter), input.exitOnReply,
      JSON.stringify(input.exitOnStatus), input.quietStart, input.quietEnd, user.id,
    ],
  );
  res.status(201).json({ id: row?.id });
}));

outreachRouter.patch('/sequences/:id', asyncHandler(async (req, res) => {
  const input = sequenceSchema.partial().parse(req.body);
  const map: Record<string, string> = {
    name: 'name', description: 'description', isActive: 'is_active', moduleName: 'module_name',
    enrolTrigger: 'enrol_trigger', enrolFilter: 'enrol_filter', exitOnReply: 'exit_on_reply',
    exitOnStatus: 'exit_on_status', quietStart: 'quiet_start', quietEnd: 'quiet_end',
  };
  const sets: string[] = [];
  const params: unknown[] = [req.params.id];
  for (const [key, value] of Object.entries(input)) {
    const col = map[key];
    if (!col) continue;
    params.push(col === 'enrol_filter' || col === 'exit_on_status' ? JSON.stringify(value) : value);
    sets.push(`${col} = $${params.length}`);
  }
  if (sets.length) {
    await db.query(`UPDATE ipy_sequence SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
  }
  res.json({ ok: true });
}));

outreachRouter.delete('/sequences/:id', asyncHandler(async (req, res) => {
  await db.query(`DELETE FROM ipy_sequence WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

const stepSchema = z.object({
  sequence: z.number().int().min(1),
  delayMinutes: z.number().int().min(0).max(60 * 24 * 90),
  channel: z.enum(['whatsapp', 'email', 'task', 'sms']).default('whatsapp'),
  templateName: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  buttons: z.array(z.object({ id: z.string(), title: z.string().max(20) })).max(3).default([]),
  fallbackToDevice: z.boolean().default(true),
  isActive: z.boolean().default(true),
});

outreachRouter.put('/sequences/:id/steps', asyncHandler(async (req, res) => {
  const input = z.object({ steps: z.array(stepSchema) }).parse(req.body);

  // Replace wholesale rather than diffing: the editor sends the full list, and
  // a partial update is how you end up with an orphaned step firing at 3am
  // three weeks after someone thought they deleted it.
  await db.query(`DELETE FROM ipy_sequence_step WHERE sequence_id = $1`, [req.params.id]);
  for (const step of input.steps) {
    await db.query(
      `INSERT INTO ipy_sequence_step
        (sequence_id, sequence, delay_minutes, channel, template_name, subject, body, buttons, fallback_to_device, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        req.params.id, step.sequence, step.delayMinutes, step.channel,
        step.templateName ?? null, step.subject ?? null, step.body ?? null,
        JSON.stringify(step.buttons), step.fallbackToDevice, step.isActive,
      ],
    );
  }
  res.json({ ok: true, steps: input.steps.length });
}));

outreachRouter.post('/sequences/:id/enrol', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const input = z.object({ recordIds: z.array(z.string().uuid()).min(1).max(1000) }).parse(req.body);

  const results = { enrolled: 0, skipped: [] as { recordId: string; reason: string }[] };
  for (const recordId of input.recordIds) {
    const result = await sequences.enrol({ sequenceId: req.params.id, recordId, enrolledBy: user.id });
    if (result.enrolled) results.enrolled++;
    else results.skipped.push({ recordId, reason: result.reason ?? 'Skipped' });
  }
  res.json(results);
}));

outreachRouter.post('/enrolments/:id/exit', asyncHandler(async (req, res) => {
  const input = z.object({ reason: z.string().default('Removed manually') }).parse(req.body ?? {});
  await sequences.exitEnrolment(req.params.id, input.reason);
  res.json({ ok: true });
}));

/** Run due steps immediately — used by the "Run now" button and by tests. */
outreachRouter.post('/sequences/run', asyncHandler(async (_req, res) => {
  res.json(await sequences.runDueEnrolments());
}));

// ---------------------------------------------------------------------------
// Auto-reply rules
// ---------------------------------------------------------------------------

outreachRouter.get('/autoreply', asyncHandler(async (_req, res) => {
  const rows = await db.query(
    `SELECT * FROM ipy_autoreply_rule ORDER BY sequence, created_at`,
  );
  res.json(rows.rows);
}));

const ruleSchema = z.object({
  name: z.string().min(1).max(120),
  isActive: z.boolean().default(true),
  sequence: z.number().int().min(0).max(9999).default(100),
  triggerType: z.enum(['keyword', 'welcome', 'fallback']).default('keyword'),
  matchType: z.enum(['contains', 'exact']).default('contains'),
  keywords: z.array(z.string()).default([]),
  replyText: z.string().min(1).max(4096),
  buttons: z.array(z.object({ id: z.string(), title: z.string().max(20) })).max(3).default([]),
  buttonRoutes: z.record(z.string().uuid()).default({}),
  businessHoursOnly: z.boolean().default(false),
  handoff: z.boolean().default(false),
  mediaUrl: z.string().url().nullable().optional(),
  isRoutedOnly: z.boolean().default(false),
});

outreachRouter.post('/autoreply', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'whatsapp.templates');
  const input = ruleSchema.parse(req.body);
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_autoreply_rule
      (name, is_active, sequence, trigger_type, match_type, keywords, reply_text,
       buttons, button_routes, business_hours_only, handoff, media_url, is_routed_only)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [
      input.name, input.isActive, input.sequence, input.triggerType, input.matchType,
      JSON.stringify(input.keywords), input.replyText, JSON.stringify(input.buttons),
      JSON.stringify(input.buttonRoutes), input.businessHoursOnly, input.handoff,
      input.mediaUrl ?? null, input.isRoutedOnly,
    ],
  );
  res.status(201).json({ id: row?.id });
}));

outreachRouter.patch('/autoreply/:id', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'whatsapp.templates');
  const input = ruleSchema.partial().parse(req.body);
  const map: Record<string, string> = {
    name: 'name', isActive: 'is_active', sequence: 'sequence', triggerType: 'trigger_type',
    matchType: 'match_type', keywords: 'keywords', replyText: 'reply_text', buttons: 'buttons',
    buttonRoutes: 'button_routes', businessHoursOnly: 'business_hours_only',
    handoff: 'handoff', mediaUrl: 'media_url', isRoutedOnly: 'is_routed_only',
  };
  const jsonCols = new Set(['keywords', 'buttons', 'button_routes']);
  const sets: string[] = [];
  const params: unknown[] = [req.params.id];
  for (const [key, value] of Object.entries(input)) {
    const col = map[key];
    if (!col) continue;
    params.push(jsonCols.has(col) ? JSON.stringify(value) : value);
    sets.push(`${col} = $${params.length}`);
  }
  if (sets.length) {
    await db.query(`UPDATE ipy_autoreply_rule SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
  }
  res.json({ ok: true });
}));

outreachRouter.delete('/autoreply/:id', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'whatsapp.templates');
  await db.query(`DELETE FROM ipy_autoreply_rule WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

/** Dry-run the matcher so a rule can be checked without messaging anyone. */
outreachRouter.post('/autoreply/test', asyncHandler(async (req, res) => {
  const input = z.object({
    text: z.string().default(''),
    buttonPayload: z.string().nullable().optional(),
  }).parse(req.body);

  const { matchRule } = await import('../../integrations/whatsapp/autoreply.js');
  const rule = await matchRule(input.text, input.buttonPayload ?? null);
  res.json(rule
    ? { matched: true, rule: { id: rule.id, name: rule.name, replyText: rule.reply_text, buttons: rule.buttons } }
    : { matched: false });
}));
