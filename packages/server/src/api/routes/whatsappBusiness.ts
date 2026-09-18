/**
 * The official WhatsApp Business route, as the CRM's own screens see it.
 *
 * Deliberately thin. Admin work — pasting credentials, switching a provider on
 * — goes through the integration card that already exists for every other
 * service, so there is one place in this CRM where a key is entered and one
 * place where it is encrypted. What is here is what the *card* cannot answer:
 * which provider is live, what it can actually do, whether its credentials
 * work, and sending a message.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { blockApiKey, getUser, requireAuth } from '../../middleware/auth.js';
import { assertCapability } from '../../core/permissions/index.js';
import { BadRequestError, NotFoundError } from '../../utils/errors.js';
import {
  activeBusinessProvider, businessProvider, BUSINESS_PROVIDERS,
} from '../../integrations/whatsapp/business/registry.js';
import { sendOnBusinessNumber } from '../../integrations/whatsapp/business/send.js';

export const whatsappBusinessRouter = Router();
whatsappBusinessRouter.use(requireAuth, blockApiKey);

/**
 * What the CRM can do on WhatsApp right now.
 *
 * Every screen asks this before offering a control: a provider that cannot
 * send free text (AiSensy's campaign API is templates only) should show the
 * template picker rather than a message box that fails on send.
 */
whatsappBusinessRouter.get('/status', asyncHandler(async (_req, res) => {
  const provider = activeBusinessProvider();
  if (!provider) {
    res.json({ connected: false, provider: null, capabilities: [], businessNumber: null });
    return;
  }
  res.json({
    connected: await provider.isConfigured(),
    provider: provider.name,
    capabilities: [...provider.capabilities],
    businessNumber: await provider.businessNumber(),
  });
}));

/** The four adapters and what each is able to do, for the admin panel. */
whatsappBusinessRouter.get('/providers', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'admin.integrations');
  res.json(BUSINESS_PROVIDERS.map((entry) => ({
    id: entry.id,
    label: entry.label,
    capabilities: [...entry.provider.capabilities],
    webhookPath: `/api/webhooks/whatsapp/${entry.id.replace('whatsapp_', '')}`,
  })));
}));

/** Prove the credentials, before anybody relies on them with a customer waiting. */
whatsappBusinessRouter.post('/providers/:id/test', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'admin.integrations');
  const provider = businessProvider(req.params.id);
  if (!provider) throw new NotFoundError('No such WhatsApp provider.');
  res.json(await provider.testConnection());
}));

/** The approved template list, where the provider hands it back. */
whatsappBusinessRouter.get('/templates', asyncHandler(async (_req, res) => {
  const provider = activeBusinessProvider();
  if (!provider) { res.json([]); return; }
  if (!provider.capabilities.has('templateSync')) { res.json([]); return; }
  res.json(await provider.listTemplates());
}));

const sendSchema = z.object({
  to: z.string().min(6).max(24),
  text: z.string().min(1).max(4096).optional(),
  template: z.object({
    name: z.string().min(1).max(120),
    language: z.string().min(2).max(10).default('en'),
    params: z.array(z.string().max(500)).max(20).default([]),
    headerMedia: z.object({ link: z.string().url(), filename: z.string().max(200).optional() }).optional(),
  }).optional(),
  recordId: z.string().uuid().optional(),
}).refine((value) => Boolean(value.text) !== Boolean(value.template), {
  message: 'Send either a message or a template, not both.',
});

whatsappBusinessRouter.post('/send', asyncHandler(async (req, res) => {
  const user = getUser(req);
  // The same capability that already gates every other outbound message in the
  // CRM. A new one would mean re-granting the team something they have.
  await assertCapability(user, 'whatsapp.send');
  const input = sendSchema.parse(req.body ?? {});
  if (!activeBusinessProvider()) throw new BadRequestError('No official WhatsApp provider is switched on.');

  res.json(await sendOnBusinessNumber({
    userId: user.id,
    to: input.to,
    text: input.text,
    template: input.template,
    recordId: input.recordId ?? null,
  }));
}));
