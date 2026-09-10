/**
 * The reporter's endpoints: submit from anywhere in the app, list, verify,
 * reopen. One route serves the screenshots for a report through the same
 * permission-checked file path every other attachment uses.
 *
 * Everything here is Hinglish-first in its responses, because the person it
 * serves is the owner of the business, not an engineer.
 */
import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { getUser, requireAuth } from '../../middleware/auth.js';
import { BadRequestError, NotFoundError } from '../../utils/errors.js';
import { db } from '../../db/pool.js';
import {
  submitFeedback, verifyFeedback, listFeedback, logEvent,
} from '../../core/feedback/index.js';

export const feedbackRouter = Router();
feedbackRouter.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const submitSchema = z.object({
  text: z.string().trim().min(3, 'Kripya thoda detail mein likhein (kam se kam 3 characters).').max(4000),
  kind: z.enum(['bug', 'idea', 'question']).default('bug'),
  severity: z.enum(['blocking', 'important', 'minor']).default('important'),
  moduleName: z.string().max(64).nullable().optional(),
  recordId: z.string().uuid().nullable().optional(),
  route: z.string().max(200).nullable().optional(),
});

/**
 * Submit with optional screenshots. The multipart form carries the text fields
 * and up to four images; each image lands in ipy_attachment against the new
 * feedback row, through the same storage driver as every other file.
 */
feedbackRouter.post('/', upload.array('screenshots', 4), asyncHandler(async (req, res) => {
  const user = getUser(req);
  const input = submitSchema.parse({
    text: req.body.text,
    kind: req.body.kind || 'bug',
    severity: req.body.severity || 'important',
    moduleName: req.body.moduleName || null,
    recordId: req.body.recordId || null,
    route: req.body.route || null,
  });

  const id = await submitFeedback({
    userId: user.id,
    text: input.text,
    kind: input.kind,
    severity: input.severity,
    moduleName: input.moduleName ?? null,
    recordId: input.recordId ?? null,
    route: input.route ?? null,
  });

  const files = (req as unknown as { files?: Express.Multer.File[] }).files ?? [];
  for (const file of files) {
    if (!file.mimetype.startsWith('image/')) continue;
    const { getDriver } = await import('../../core/storage/index.js');
    const { buildStorageKey } = await import('../../core/storage/keys.js');
    const driver = await getDriver();
    const ext = /\.(png|jpe?g|webp)$/i.test(file.originalname)
      ? file.originalname.slice(file.originalname.lastIndexOf('.')).toLowerCase() : '.png';
    const key = await buildStorageKey({ recordId: id, originalName: file.originalname, ext });
    await driver.save(key, file.buffer, file.mimetype);
    await db.query(
      `INSERT INTO ipy_attachment (record_id, feedback_id, file_name, mime_type, size, storage_key, url, uploaded_by)
       VALUES (NULL, $1, $2, $3, $4, $5, $6, $7)`,
      [id, file.originalname, file.mimetype, file.size, key, `/api/files/${key}`, user.id],
    );
  }

  res.status(201).json({ id, message: 'Report mil gayi! Poori report email par pahunch gayi hai.' });
}));

feedbackRouter.get('/', asyncHandler(async (req, res) => {
  const user = getUser(req);
  res.json(await listFeedback(user.id));
}));

const verifySchema = z.object({
  ok: z.boolean(),
  note: z.string().max(2000).optional(),
});

feedbackRouter.post('/:id/verify', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const input = verifySchema.parse(req.body);
  await verifyFeedback({ feedbackId: req.params.id, userId: user.id, ok: input.ok, note: input.note });
  res.json({ ok: true, message: input.ok ? 'Shukriya! Note kar liya.' : 'Theek hai — dobara dekhne ke liye report phir se khul gayi.' });
}));

/** A comment from the reporter mid-flight: context the agent should have. */
feedbackRouter.post('/:id/note', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const input = z.object({ text: z.string().trim().min(1).max(2000) }).parse(req.body);
  const fb = await db.queryOne<{ id: string; user_id: string; issue_number: number | null }>(
    `SELECT id, user_id, issue_number FROM ipy_feedback WHERE id = $1`,
    [req.params.id],
  );
  if (!fb || fb.user_id !== user.id) throw new NotFoundError('Report not found');
  await logEvent(fb.id, 'submitted', input.text, 'reporter');

  const { getGithubConfig, addComment: ghComment } = await import('../../core/feedback/index.js');
  const ghc = await getGithubConfig();
  if (ghc && fb.issue_number) {
    await ghComment({
      repo: ghc.repo, token: ghc.token, issue: fb.issue_number,
      body: `Follow-up from the reporter:\n\n> ${input.text}`,
    }).catch(() => undefined);
  }
  res.json({ ok: true });
}));
