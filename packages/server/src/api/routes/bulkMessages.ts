/**
 * SMS and RCS campaigns through MSG91 — the routes.
 *
 * Same split as WhatsApp campaigns: building one is `whatsapp.send`, deciding
 * that it goes to many people is `whatsapp.templates`. (Those capability names
 * are old and stored on live profile rows; they gate every channel's messages.)
 * API keys are blocked outright, as for WhatsApp campaigns: approval is a person
 * looking at a number.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { blockApiKey, getScope, getUser, requireAuth } from '../../middleware/auth.js';
import { assertCapability } from '../../core/permissions/index.js';
import {
  approveBulk, bulkRecipients, createBulk, listBulk, previewBulk, sendTestMessage, setBulkStatus,
} from '../../integrations/msg91/bulk.js';
import { getMsg91ProviderSettings } from '../../core/settings/integrations.js';

export const bulkMessagesRouter = Router();
bulkMessagesRouter.use(requireAuth, blockApiKey);

const audienceSchema = z.object({
  view: z.string().uuid().optional(),
  filter: z.any().optional(),
  everyone: z.boolean().optional(),
});

const contentSchema = z.object({
  channel: z.enum(['sms', 'rcs']),
  templateId: z.string().max(100).optional(),
  variables: z.record(z.string().max(100), z.string().max(500)).optional(),
  body: z.string().max(2000).optional(),
});

/** Is MSG91 ready — and is it the right time of day to send? Drives the screen's banner. */
bulkMessagesRouter.get('/status', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'whatsapp.send');
  const s = getMsg91ProviderSettings();
  res.json({
    connected: s.active && Boolean(s.authKey),
    smsReady: s.active && Boolean(s.authKey) && Boolean(s.smsTemplateId),
    rcsReady: s.active && Boolean(s.authKey) && Boolean(s.rcsProjectId),
    defaultSmsTemplateId: s.smsTemplateId,
  });
}));

bulkMessagesRouter.get('/', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'whatsapp.send');
  res.json(await listBulk());
}));

bulkMessagesRouter.post('/', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'whatsapp.send');
  const input = z.object({
    name: z.string().min(1).max(120),
    module: z.string().min(1),
    audience: audienceSchema,
    content: contentSchema,
  }).parse(req.body ?? {});
  res.json(await createBulk({ ...input, userId: user.id }));
}));

/** Who it would reach and what the first few would read. Writes nothing. */
bulkMessagesRouter.post('/preview', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'whatsapp.send');
  const input = z.object({
    module: z.string().min(1),
    audience: audienceSchema,
    content: contentSchema,
  }).parse(req.body ?? {});
  res.json(await previewBulk({ ctx: getScope(req), ...input }));
}));

/** One message to one number — yours — so the first real send is not a campaign. */
bulkMessagesRouter.post('/test', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'whatsapp.templates');
  const input = z.object({ to: z.string().min(8).max(20), content: contentSchema }).parse(req.body ?? {});
  res.json(await sendTestMessage(input));
}));

bulkMessagesRouter.post('/:id/approve', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'whatsapp.templates');
  const input = z.object({
    expectedCount: z.number().int().min(0),
    confirmLarge: z.boolean().optional(),
  }).parse(req.body ?? {});
  res.json(await approveBulk({
    ctx: getScope(req), userId: user.id, bulkId: req.params.id!,
    expectedCount: input.expectedCount, confirmLarge: input.confirmLarge,
  }));
}));

bulkMessagesRouter.post('/:id/status', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'whatsapp.templates');
  const input = z.object({ status: z.enum(['paused', 'running', 'cancelled']) }).parse(req.body ?? {});
  await setBulkStatus(req.params.id!, input.status);
  res.json({ ok: true });
}));

bulkMessagesRouter.get('/:id/recipients', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'whatsapp.send');
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  res.json(await bulkRecipients(req.params.id!, status));
}));
