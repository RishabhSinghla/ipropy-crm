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
import { blockApiKey, getUser, requireAuth } from '../../middleware/auth.js';
import { assertCapability } from '../../core/permissions/index.js';
import { importGroupExport, searchMarket } from '../../core/market/feed.js';
import { BadRequestError } from '../../utils/errors.js';

export const marketRouter = Router();
marketRouter.use(requireAuth);

// An export of a busy group for a year runs to a few megabytes of text.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

marketRouter.post('/import', blockApiKey, upload.single('file'), asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'records.import');
  const { group } = z.object({ group: z.string().trim().min(1).max(120) }).parse(req.body);
  const text = req.file?.buffer.toString('utf8') ?? '';
  if (!text.trim()) throw new BadRequestError('Choose the .txt file WhatsApp made when you exported the group');
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
