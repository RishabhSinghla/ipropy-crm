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
import { getPostDetail, importGroupExport, afterImport, searchMarket } from '../../core/market/feed.js';
import { nudgeMarketWork } from '../../core/market/enrich.js';
import { listGroups, listImports, queueImports } from '../../core/market/imports.js';
import { matchDeal } from '../../core/market/matchDeal.js';
import { DEAL_STATUSES, findCrossMatchPage, invalidateMarketMatches, MATCH_SIDES, MATCH_SORTS, recordOutcome } from '../../core/market/crossMatch.js';
import { dealsOfRecord } from '../../core/market/dealerDeals.js';
import { DEAL_PATCH, deleteDeal, duplicateDeal, matchCounts, MATCH_COUNT_LIMIT, updateDeal } from '../../core/market/associateDeals.js';
import { dealerDirectory, saveDealersAsAssociates } from '../../core/market/dealers.js';
import { chatTextFromZip, looksLikeAZip } from '../../core/market/unzipChat.js';
import { NotFoundError, BadRequestError } from '../../utils/errors.js';

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
  const outcome = await importGroupExport(group, text, user.id);
  void afterImport(group);
  res.json(outcome);
}));

// A year of a busy group is a few megabytes; a drop may be dozens of them.
const uploadMany = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024, files: 60 } });

/**
 * Drop any number of .txt or .zip exports. Each chat is named from its file, read in the
 * background and only from where its group was last read to; the answer is a row per chat
 * to watch on `GET /imports`.
 */
marketRouter.post('/import-files', blockApiKey, uploadMany.array('files', 60), asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'records.import');
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) throw new BadRequestError('Drop the .txt or .zip files WhatsApp made when you exported the groups');
  const { group } = z.object({ group: z.string().trim().max(120).optional() }).parse(req.body);
  const imports = await queueImports(
    files.map((file) => ({ name: Buffer.from(file.originalname, 'latin1').toString('utf8'), buffer: file.buffer })),
    group || null,
    user.id,
  );
  res.status(202).json({ imports });
}));

/** What has been dropped, newest first, and what came of each. */
marketRouter.get('/imports', asyncHandler(async (_req, res) => {
  res.json({ imports: await listImports() });
}));

/** Every group the feed reads, and what it holds from each. */
marketRouter.get('/groups', asyncHandler(async (_req, res) => {
  res.json({ groups: await listGroups() });
}));

/** One message in full, with the properties read out of it and everywhere it was posted. */
marketRouter.get('/posts/:id', asyncHandler(async (req, res) => {
  const detail = await getPostDetail(z.string().uuid().parse(req.params.id));
  if (!detail) throw new NotFoundError('That message is no longer in the feed');
  res.json(detail);
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
    minJevFit: z.coerce.number().min(0).max(1).optional(),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    category: z.string().trim().max(40).optional(),
    sizeMinSqYd: z.coerce.number().positive().optional(),
    sizeMaxSqYd: z.coerce.number().positive().optional(),
    area: z.string().trim().max(60).optional(),
    bhk: z.coerce.number().int().min(1).max(14).optional(),
    purpose: z.enum(['sale', 'rent']).optional(),
    sort: z.enum(MATCH_SORTS).optional(),
    status: z.enum(['new', 'called', 'meeting', 'won', 'lost']).optional(),
    day: z.enum(['today', 'yesterday']).optional(),
    sides: z.string().max(60).optional(),
  }).parse(req.query);
  const { page, pageSize, sides: sidesText, ...rest } = query;
  const sides = (sidesText ?? '').split(',').filter((side): side is (typeof MATCH_SIDES)[number] => (MATCH_SIDES as readonly string[]).includes(side));
  const started = Date.now();
  const found = await findCrossMatchPage({
    ...rest,
    sides,
    crossGroupOnly: query.crossGroupOnly !== 'false',
    // Worked pairings stay on the sheet, coloured by what was decided; only the two "put away" answers leave it.
    includeWorked: query.includeWorked !== 'false',
  }, page, pageSize);
  // The count rides in a header, not a wrapped body: this endpoint has always answered a bare list.
  res.setHeader('X-Total-Count', String(found.total));
  res.setHeader('X-Page', String(page));
  res.setHeader('X-Page-Size', String(pageSize));
  res.setHeader('Server-Timing', `sheet;dur=${Date.now() - started}`);
  res.json(found.matches);
}));

/**
 * The Refresh button: have Jev read anything waiting and check the new pairings now,
 * instead of at the next 15-minute visit. Answers at once; the work runs behind it.
 */
marketRouter.post('/refresh', blockApiKey, asyncHandler(async (_req, res) => {
  invalidateMarketMatches();
  nudgeMarketWork();
  res.json({ started: true });
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

/** The deals one dealer posted, as four lists for their record's tabs. Needs permission to open the record. */
marketRouter.get('/records/:module/:id/deals', asyncHandler(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  res.json(await dealsOfRecord(getScope(req), z.string().min(1).max(60).parse(req.params.module), id));
}));

const dealParams = (req: { params: Record<string, string> }): { module: string; id: string; ref: string } => ({
  module: z.string().min(1).max(60).parse(req.params.module),
  id: z.string().uuid().parse(req.params.id),
  ref: z.string().min(1).max(80).parse(req.params.ref),
});

/** Fill in a row's form. The first change to a row the parser read makes it the team's own. */
marketRouter.patch('/records/:module/:id/deals/:ref', blockApiKey, asyncHandler(async (req, res) => {
  const { module, id, ref } = dealParams(req);
  res.json({ id: await updateDeal(getScope(req), module, id, ref, DEAL_PATCH.parse(req.body)) });
}));

marketRouter.post('/records/:module/:id/deals/:ref/duplicate', blockApiKey, asyncHandler(async (req, res) => {
  const { module, id, ref } = dealParams(req);
  res.json({ id: await duplicateDeal(getScope(req), module, id, ref) });
}));

marketRouter.delete('/records/:module/:id/deals/:ref', blockApiKey, asyncHandler(async (req, res) => {
  const { module, id, ref } = dealParams(req);
  await deleteDeal(getScope(req), module, id, ref);
  res.json({ ok: true });
}));

/** How many of our own records each post fits, for the Matching button on a row. */
marketRouter.get('/deal-match-counts', asyncHandler(async (req, res) => {
  const posts = z.string().max(2000).parse(req.query.posts ?? '').split(',').filter(Boolean);
  const ids = z.array(z.string().uuid()).max(MATCH_COUNT_LIMIT).parse(posts);
  res.json(await matchCounts(ids, getScope(req)));
}));
