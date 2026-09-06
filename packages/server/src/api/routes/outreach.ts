/**
 * The one-tap WhatsApp hand-off — per record, not a queue page.
 *
 * This used to carry the Outreach module's bulk surfaces too (broadcasts, drip
 * sequences, auto-reply rules). Those pages are gone from the app at the
 * owner's request — messaging happens on the lead, not on a queue — so the
 * routes for them went with the pages. What remains is the half the record
 * detail page and the composer still depend on: preparing a wa.me link,
 * queueing a message for a human to tap send, and logging what was sent.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { getScope, getUser, requireAuth } from '../../middleware/auth.js';
import { NotFoundError } from '../../utils/errors.js';
import { assertCapability } from '../../core/permissions/index.js';
import { recordService } from '../../core/entity/recordService.js';
import * as device from '../../integrations/whatsapp/deviceSend.js';
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

outreachRouter.get('/device-queue', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'whatsapp.send');
  res.json(await device.listPending(user.id));
}));

/** Compose a link for one record without queueing anything. */
outreachRouter.post('/device-link', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'whatsapp.send');
  const input = z.object({
    handle: z.string().min(6),
    body: z.string().min(1).max(1500),
    recordId: z.string().uuid().nullable().optional(),
    module: z.string().default('leads'),
    render: z.boolean().default(true),
  }).parse(req.body);

  let body = input.body;
  if (input.render) {
    const record = input.recordId
      ? await recordService.getRecord(getScope(req), input.module, input.recordId)
      : null;
    body = record
      ? await device.renderForValues(input.body, record.values, record.label)
      : await device.renderForRecord(input.body, null, input.module);
  } else if (input.recordId) {
    // Even without merge rendering, possession of an id must not become an
    // access oracle for records outside the caller's scope.
    await recordService.getRecord(getScope(req), input.module, input.recordId);
  }

  res.json({ link: device.buildWaLink(input.handle, body), body });
}));

outreachRouter.post('/device-queue', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'whatsapp.send');
  const input = z.object({
    handle: z.string().min(6),
    body: z.string().min(1),
    recordId: z.string().uuid().nullable().optional(),
    module: z.string().optional(),
    name: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
  }).parse(req.body);

  const record = input.recordId
    ? await recordService.getRecord(getScope(req), input.module ?? 'leads', input.recordId)
    : null;
  const body = record
    ? await device.renderForValues(input.body, record.values, record.label)
    : input.body;
  const result = await device.queueDeviceSend({ ...input, body, assignedTo: user.id });
  res.status(result.skipped ? 200 : 201).json(result);
}));

/** Reword a queued message. Merge tokens are re-rendered, as they are on queue. */
outreachRouter.patch('/device-queue/:id', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'whatsapp.send');
  const input = z.object({ body: z.string().min(1).max(1500) }).parse(req.body);

  const existing = await device.findPending(req.params.id, user.id, user.isAdmin);
  if (!existing) throw new NotFoundError('That message is no longer waiting to be sent');

  const body = existing.recordId
    ? await (async () => {
      const record = await recordService.getRecord(
        getScope(req), existing.module ?? 'leads', existing.recordId!,
      );
      return device.renderForValues(input.body, record.values, record.label);
    })()
    : input.body;

  const updated = await device.editBody(req.params.id, body, user.id, user.isAdmin);
  if (!updated) throw new NotFoundError('That message is no longer waiting to be sent');
  res.json(updated);
}));

outreachRouter.post('/device-queue/:id/opened', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'whatsapp.send');
  await device.markOpened(req.params.id, user.id, user.isAdmin);
  res.json({ ok: true });
}));

outreachRouter.post('/device-queue/:id/sent', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'whatsapp.send');
  res.json(await device.markSent(req.params.id, user.id, user.isAdmin));
}));

outreachRouter.post('/device-queue/:id/skip', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'whatsapp.send');
  const input = z.object({ reason: z.string().optional() }).parse(req.body ?? {});
  await device.skip(req.params.id, user.id, user.isAdmin, input.reason);
  res.json({ ok: true });
}));

/**
 * Log a message the rep sent straight from a record page, bypassing the queue.
 * Separate from the queue endpoints because there was never a queued row.
 */
outreachRouter.post('/device-sent', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'whatsapp.send');
  const input = z.object({
    handle: z.string().min(6),
    body: z.string().min(1),
    recordId: z.string().uuid().nullable().optional(),
    module: z.string().default('leads'),
  }).parse(req.body);

  if (input.recordId) await recordService.getRecord(getScope(req), input.module, input.recordId);
  const messageId = await device.logDeviceMessage({ ...input, sentBy: user.id });
  res.status(201).json({ messageId });
}));
