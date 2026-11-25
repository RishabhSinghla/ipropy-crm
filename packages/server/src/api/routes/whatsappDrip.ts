/**
 * Admin: the slow promotional drip on the linked WhatsApp numbers.
 *
 * There is deliberately no route here that sends to a list. These routes create a queue, show who would be in it,
 * start / pause / resume / stop it, and send one test to a number the admin owns. The messages themselves leave from
 * the background clock in `integrations/whatsapp/business/drip.ts`, one at a time, through the ordinary send path.
 *
 * Admins only, and never an API key: starting a queue is a person looking at a number.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { blockApiKey, getScope, getUser, requireAdmin, requireAuth } from '../../middleware/auth.js';
import { logger } from '../../utils/logger.js';
import {
  createDrip, defaultVariants, dripDetail, dripSkips, dripSummaries, pauseDrip, previewDrip, resumeDrip, sendDripTest,
  startDrip, stopDrip, updateDrip,
} from '../../integrations/whatsapp/business/drip.js';
import { HARD_MAX_PER_NUMBER_PER_DAY, MIN_GAP_SECONDS, OPT_OUT_LINE } from '../../integrations/whatsapp/business/dripRules.js';

export const whatsappDripRouter = Router();
whatsappDripRouter.use(requireAuth, blockApiKey, requireAdmin);

const speed = z.object({
  capStart: z.number().int().optional(), capStep: z.number().int().optional(), capEveryDays: z.number().int().optional(),
  capMax: z.number().int().optional(), gapMinSeconds: z.number().int().optional(), gapMaxSeconds: z.number().int().optional(),
  windowFrom: z.number().int().optional(), windowTo: z.number().int().optional(),
}).partial();
const variants = z.array(z.string().max(1000)).min(1).max(6);
/** Which kind of contact a queue is for. The saved list is read from this module; it defaults to Leads, as before. */
const dripModule = z.enum(['leads', 'properties', 'associates']).default('leads');

/** Everything the screen needs in one read: the queues, the starting wording, and the limits the code enforces. */
whatsappDripRouter.get('/', asyncHandler(async (_req, res) => {
  res.json({
    drips: await dripSummaries(),
    defaults: { variants: defaultVariants(), optOutLine: OPT_OUT_LINE, hardMaxPerNumberPerDay: HARD_MAX_PER_NUMBER_PER_DAY, minGapSeconds: MIN_GAP_SECONDS },
  });
}));

whatsappDripRouter.get('/:id', asyncHandler(async (req, res) => {
  res.json({ ...(await dripDetail(req.params.id)), skips: await dripSkips(req.params.id) });
}));

/** Who would be in it, and what the first few would read. Sends nothing. */
whatsappDripRouter.post('/preview', asyncHandler(async (req, res) => {
  const body = z.object({ view: z.string().min(1), variants: z.array(z.string()).max(6), moduleName: dripModule }).parse(req.body ?? {});
  res.json(await previewDrip({ ctx: getScope(req), moduleName: body.moduleName, view: body.view, variants: body.variants }));
}));

whatsappDripRouter.post('/', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const body = z.object({
    name: z.string().min(1).max(120), view: z.string().min(1), moduleName: dripModule, variants, numberIds: z.array(z.string().uuid()).min(1),
    maxTotal: z.number().int().positive().max(60000).nullish(), speed: speed.optional(),
  }).parse(req.body ?? {});
  const made = await createDrip({ ...body, userId: user.id });
  logger.info({ by: user.id, drip: made.id }, 'whatsapp drip created');
  res.json(made);
}));

whatsappDripRouter.put('/:id', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const body = z.object({
    name: z.string().min(1).max(120), variants, numberIds: z.array(z.string().uuid()).min(1),
    maxTotal: z.number().int().positive().max(60000).nullable(), speed,
  }).partial().parse(req.body ?? {});
  logger.info({ by: user.id, drip: req.params.id }, 'whatsapp drip changed');
  await updateDrip(req.params.id, user.id, body);
  res.json({ ok: true });
}));

/** Start: the count the admin was shown must still be the count, or it refuses. */
whatsappDripRouter.post('/:id/start', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const body = z.object({ expectedCount: z.number().int().min(0), confirmLarge: z.boolean().optional() }).parse(req.body ?? {});
  logger.info({ by: user.id, drip: req.params.id, expected: body.expectedCount }, 'whatsapp drip start');
  res.json(await startDrip({ ctx: getScope(req), userId: user.id, dripId: req.params.id, ...body }));
}));

whatsappDripRouter.post('/:id/pause', asyncHandler(async (req, res) => {
  logger.info({ by: getUser(req).id, drip: req.params.id }, 'whatsapp drip pause');
  await pauseDrip(req.params.id, getUser(req).id);
  res.json({ ok: true });
}));

whatsappDripRouter.post('/:id/resume', asyncHandler(async (req, res) => {
  const body = z.object({ numberIds: z.array(z.string().uuid()).optional() }).parse(req.body ?? {});
  logger.info({ by: getUser(req).id, drip: req.params.id }, 'whatsapp drip resume');
  await resumeDrip(req.params.id, getUser(req).id, body.numberIds);
  res.json({ ok: true });
}));

whatsappDripRouter.post('/:id/stop', asyncHandler(async (req, res) => {
  logger.info({ by: getUser(req).id, drip: req.params.id }, 'whatsapp drip stop');
  await stopDrip(req.params.id, getUser(req).id);
  res.json({ ok: true });
}));

/** One test message to a number that is a contact in the CRM (the admin's own). Through the ordinary send path. */
whatsappDripRouter.post('/test/send', asyncHandler(async (req, res) => {
  const body = z.object({ mobile: z.string().min(10).max(20), numberId: z.string().uuid(), variants }).parse(req.body ?? {});
  logger.info({ by: getUser(req).id, number: body.numberId }, 'whatsapp drip test message');
  res.json(await sendDripTest({ userId: getUser(req).id, ...body }));
}));
