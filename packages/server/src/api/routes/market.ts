/**
 * The market feed over HTTP: put a dealer group's export in, and search it.
 *
 * Anybody signed in may search — what dealers broadcast to a group is market
 * talk the whole desk works from, not one rep's customer. Putting a group in
 * is `records.import`, the same capability as importing contacts, because it
 * is the same kind of decision: a file somebody chose becomes data everybody
 * sees.
 */
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { blockApiKey, getScope, getUser, requireAuth } from '../../middleware/auth.js';
import { assertCapability } from '../../core/permissions/index.js';
import { importGroupExport, searchMarket } from '../../core/market/feed.js';
import { matchDeal } from '../../core/market/matchDeal.js';
import { DEAL_STATUSES, findCrossMatches, recordOutcome } from '../../core/market/crossMatch.js';
import { dealerDirectory, saveDealersAsAssociates } from '../../core/market/dealers.js';
import { chatTextFromZip, looksLikeAZip } from '../../core/market/unzipChat.js';
import { BadRequestError } from '../../utils/errors.js';

export const marketRouter = Router();
marketRouter.use(requireAuth);

// An export of a busy group for a year runs to a few megabytes of text.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

marketRouter.post('/import', blockApiKey, upload.single('file'), asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'records.import');
  const { group } = z.object({ group: z.string().trim().min(1).max(120) }).parse(req.body);
  const file = req.file?.buffer;
  const text = !file ? '' : looksLikeAZip(file) ? await chatTextFromZip(file) : file.toString('utf8');
  if (!text.trim()) throw new BadRequestError('Choose the .txt or .zip file WhatsApp made when you exported the group');
  res.json(await importGroupExport(group, text, user.id));
}));

marketRouter.get('/posts', asyncHandler(async (req, res) => {
  const query = z.object({
    kind: z.enum(['have', 'want']).optional(),
    bhk: z.coerce.number().int().min(1).max(14).optional(),
    minLakh: z.coerce.number().positive().optional(),
    maxLakh: z.coerce.number().positive().optional(),
    locality: z.string().trim().max(80).optional(),
    text: z.string().trim().max(120).optional(),
    days: z.coerce.number().int().min(1).max(365).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }).parse(req.query);
  res.json(await searchMarket(query));
}));

/** Our own records this deal fits — only the ones the person asking may open. */
marketRouter.get('/posts/:id/matches', asyncHandler(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const scope = getScope(req);
  res.json(await matchDeal(id, scope));
}));

/**
 * Buyers and sellers who are in different groups: the introductions only this
 * desk can make. Posts are group talk everybody here already reads, so the
 * list is open to anyone signed in, like the search above.
 */
marketRouter.get('/matches', asyncHandler(async (req, res) => {
  const query = z.object({
    days: z.coerce.number().int().min(1).max(365).optional(),
    minScore: z.coerce.number().min(0).max(1).optional(),
    crossGroupOnly: z.enum(['true', 'false']).optional(),
    includeWorked: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  }).parse(req.query);
  res.json(await findCrossMatches({
    ...query,
    crossGroupOnly: query.crossGroupOnly !== 'false',
    includeWorked: query.includeWorked === 'true',
  }));
}));

/** What happened when somebody acted on a pairing: called, meeting, won, lost, not for us. */
marketRouter.put('/matches/:wantId/:haveId', blockApiKey, asyncHandler(async (req, res) => {
  const wantId = z.string().uuid().parse(req.params.wantId);
  const haveId = z.string().uuid().parse(req.params.haveId);
  const body = z.object({ status: z.enum(DEAL_STATUSES), note: z.string().trim().max(500).nullish() }).parse(req.body);
  await recordOutcome(wantId, haveId, body.status, body.note ?? null, getUser(req).id);
  res.json({ ok: true });
}));

/** Everyone who posts in the groups, busiest first. */
marketRouter.get('/dealers', asyncHandler(async (req, res) => {
  const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
  const dealers = await dealerDirectory();
  res.json({ total: dealers.length, dealers: dealers.slice(0, limit) });
}));

/** Add every dealer not already in the CRM to Associates. Uploads do this on their own; this is for catching up. */
marketRouter.post('/dealers/save', blockApiKey, asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'records.import');
  res.json(await saveDealersAsAssociates(await dealerDirectory()));
}));
