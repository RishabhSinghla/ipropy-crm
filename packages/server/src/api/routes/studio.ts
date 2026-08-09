/**
 * Studio — saved designs, renders and AI photo editing.
 *
 * The creative half of the CRM. Posts are drawn in the browser (the canvas
 * renderer is shared between preview and export, so what you see downloads);
 * reels and brochures are rendered on the server because ffmpeg and a PDF
 * writer do not run in a phone browser.
 */
import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { db } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { getUser, requireAuth } from '../../middleware/auth.js';
import { BadRequestError, NotFoundError } from '../../utils/errors.js';
import { queueRender } from '../../core/media/renderQueue.js';
import { isFfmpegAvailable } from '../../core/media/reel.js';
import { editImage, isImageEditAvailable, listPresets, type EditPreset } from '../../ai/imageEdit.js';
import { getDriver } from '../../core/storage/index.js';

export const studioRouter = Router();
studioRouter.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// ---------------------------------------------------------------------------
// Capability
//
// The studio asks once and hides what cannot work, rather than offering a
// button that fails. Both halves degrade independently: no ffmpeg still leaves
// posts and brochures; no Gemini key still leaves everything but AI edits.
// ---------------------------------------------------------------------------

studioRouter.get('/capabilities', asyncHandler(async (_req, res) => {
  res.json({
    video: await isFfmpegAvailable(),
    imageEdit: isImageEditAvailable(),
    brochure: true,
    presets: listPresets(),
  });
}));

// ---------------------------------------------------------------------------
// Designs
// ---------------------------------------------------------------------------

studioRouter.get('/designs', asyncHandler(async (req, res) => {
  const { kind, recordId } = z.object({
    kind: z.enum(['post', 'reel', 'brochure']).optional(),
    recordId: z.string().uuid().optional(),
  }).parse(req.query);

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (kind) { params.push(kind); clauses.push(`d.kind = $${params.length}`); }
  if (recordId) { params.push(recordId); clauses.push(`d.record_id = $${params.length}`); }

  const rows = await db.query(
    `SELECT d.id, d.name, d.kind, d.template_key, d.record_id, d.module_name,
            d.width, d.height, d.thumbnail, d.created_at, d.updated_at,
            r.label AS record_label,
            trim(u.first_name || ' ' || u.last_name) AS created_by_name
     FROM ipy_design d
     LEFT JOIN ipy_record r ON r.id = d.record_id
     LEFT JOIN ipy_user u ON u.id = d.created_by
     ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY d.updated_at DESC LIMIT 200`,
    params,
  );
  res.json(rows.rows);
}));

studioRouter.get('/designs/:id', asyncHandler(async (req, res) => {
  const design = await db.queryOne(`SELECT * FROM ipy_design WHERE id = $1`, [req.params.id]);
  if (!design) throw new NotFoundError('Design not found');
  res.json(design);
}));

const designSchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(['post', 'reel', 'brochure']).default('post'),
  templateKey: z.string().nullable().optional(),
  recordId: z.string().uuid().nullable().optional(),
  module: z.string().nullable().optional(),
  width: z.number().int().min(64).max(8000).default(1080),
  height: z.number().int().min(64).max(8000).default(1080),
  spec: z.record(z.unknown()).default({}),
  // A small PNG data URL for the gallery. Bounded so a full-resolution export
  // pasted in here cannot bloat every list query that reads the column.
  thumbnail: z.string().max(400_000).nullable().optional(),
});

studioRouter.post('/designs', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const input = designSchema.parse(req.body);
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_design
      (name, kind, template_key, record_id, module_name, width, height, spec, thumbnail, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [
      input.name, input.kind, input.templateKey ?? null, input.recordId ?? null,
      input.module ?? null, input.width, input.height,
      JSON.stringify(input.spec), input.thumbnail ?? null, user.id,
    ],
  );
  res.status(201).json({ id: row?.id });
}));

studioRouter.patch('/designs/:id', asyncHandler(async (req, res) => {
  const input = designSchema.partial().parse(req.body);
  const map: Record<string, string> = {
    name: 'name', kind: 'kind', templateKey: 'template_key', recordId: 'record_id',
    module: 'module_name', width: 'width', height: 'height', spec: 'spec', thumbnail: 'thumbnail',
  };
  const sets: string[] = [];
  const params: unknown[] = [req.params.id];
  for (const [key, value] of Object.entries(input)) {
    const col = map[key];
    if (!col) continue;
    params.push(col === 'spec' ? JSON.stringify(value) : value);
    sets.push(`${col} = $${params.length}`);
  }
  if (sets.length) {
    await db.query(`UPDATE ipy_design SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
  }
  res.json({ ok: true });
}));

studioRouter.delete('/designs/:id', asyncHandler(async (req, res) => {
  await db.query(`DELETE FROM ipy_design WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Renders
// ---------------------------------------------------------------------------

studioRouter.get('/renders', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const rows = await db.query(
    `SELECT j.id, j.kind, j.status, j.progress, j.error, j.output_mime,
            j.record_id, j.created_at, j.finished_at,
            j.spec -> 'title' AS title, r.label AS record_label
     FROM ipy_render_job j
     LEFT JOIN ipy_record r ON r.id = j.record_id
     WHERE j.requested_by = $1 OR $2
     ORDER BY j.created_at DESC LIMIT 50`,
    [user.id, user.isAdmin],
  );
  res.json(rows.rows);
}));

studioRouter.get('/renders/:id', asyncHandler(async (req, res) => {
  const job = await db.queryOne(`SELECT * FROM ipy_render_job WHERE id = $1`, [req.params.id]);
  if (!job) throw new NotFoundError('Render not found');
  res.json(job);
}));

/**
 * Stream the finished artefact.
 *
 * Served through the API rather than as a public URL because a brochure can
 * carry a price that is not public yet, and the storage driver may be S3 with
 * no public read.
 */
studioRouter.get('/renders/:id/file', asyncHandler(async (req, res) => {
  const job = await db.queryOne<{ output_key: string | null; output_mime: string | null; kind: string }>(
    `SELECT output_key, output_mime, kind FROM ipy_render_job WHERE id = $1`, [req.params.id],
  );
  if (!job?.output_key) throw new NotFoundError('That render has not finished yet');

  const driver = await getDriver();
  const buffer = await driver.read(job.output_key);
  if (!buffer) throw new NotFoundError('The rendered file is no longer available');

  const extension = job.kind === 'reel' ? 'mp4' : 'pdf';
  res.setHeader('Content-Type', job.output_mime ?? 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="ipropy-${job.kind}-${req.params.id.slice(0, 8)}.${extension}"`);
  res.send(buffer);
}));

studioRouter.post('/renders/reel', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const input = z.object({
    title: z.string().min(1).max(120),
    subtitle: z.string().max(160).optional(),
    price: z.string().max(60).optional(),
    cta: z.string().max(80).optional(),
    brandColour: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    secondsPerSlide: z.number().min(1.5).max(8).default(3),
    width: z.number().int().default(1080),
    height: z.number().int().default(1920),
    recordId: z.string().uuid().nullable().optional(),
    slides: z.array(z.object({
      key: z.string().optional(),
      // Only same-origin file paths or http(s). Anything else — `file://`,
      // `javascript:` — would be a server-side fetch primitive pointed at
      // whatever the caller likes.
      url: z.string().refine(
        (u) => /^https?:\/\//i.test(u) || u.startsWith('/api/files/'),
        'Photo URLs must be http(s) or an /api/files path',
      ).optional(),
      caption: z.string().max(120).optional(),
    })).min(1).max(20),
  }).parse(req.body);

  if (!(await isFfmpegAvailable())) {
    throw new BadRequestError(
      'Video rendering needs ffmpeg installed on the server. Posts and brochures still work without it.',
      { capability: 'video' },
    );
  }

  const { recordId, ...spec } = input;
  res.status(202).json(await queueRender({ kind: 'reel', spec, recordId, requestedBy: user.id }));
}));

studioRouter.post('/renders/brochure', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const input = z.object({
    title: z.string().min(1).max(160),
    subtitle: z.string().max(200).optional(),
    price: z.string().max(60).optional(),
    description: z.string().max(4000).optional(),
    facts: z.array(z.object({ label: z.string().max(60), value: z.string().max(120) })).max(12).default([]),
    highlights: z.array(z.string().max(140)).max(10).default([]),
    photos: z.array(z.object({
      key: z.string().optional(),
      url: z.string().refine(
        (u) => /^https?:\/\//i.test(u) || u.startsWith('/api/files/'),
        'Photo URLs must be http(s) or an /api/files path',
      ).optional(),
      caption: z.string().max(120).optional(),
    })).max(12).default([]),
    brandColour: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    orgName: z.string().max(80).optional(),
    phone: z.string().max(40).optional(),
    website: z.string().max(120).optional(),
    recordId: z.string().uuid().nullable().optional(),
  }).parse(req.body);

  const { recordId, ...spec } = input;
  res.status(202).json(await queueRender({ kind: 'brochure', spec, recordId, requestedBy: user.id }));
}));

// ---------------------------------------------------------------------------
// AI photo editing
// ---------------------------------------------------------------------------

studioRouter.post('/image-edit', upload.single('image'), asyncHandler(async (req, res) => {
  const user = getUser(req);
  const input = z.object({
    preset: z.enum(['virtual_stage', 'declutter', 'sky_replace', 'enhance', 'daylight', 'custom']),
    instruction: z.string().max(600).optional(),
    // Alternative to a multipart upload: an existing attachment.
    attachmentId: z.string().uuid().optional(),
  }).parse(req.body);

  let image: Buffer | null = req.file?.buffer ?? null;

  if (!image && input.attachmentId) {
    const attachment = await db.queryOne<{ storage_key: string }>(
      `SELECT storage_key FROM ipy_attachment WHERE id = $1`, [input.attachmentId],
    );
    if (attachment) {
      const driver = await getDriver();
      image = await driver.read(attachment.storage_key);
    }
  }
  if (!image) throw new BadRequestError('Upload a photo, or name an attachment to edit');

  const outcome = await editImage({
    image,
    preset: input.preset as EditPreset,
    instruction: input.instruction,
    userId: user.id,
  });

  if (!outcome.ok) {
    // 200 with `ok: false`, not an error status: "no key configured" and "the
    // model declined" are answers the UI shows inline, not failures to retry.
    res.json({ ok: false, reason: outcome.reason });
    return;
  }

  res.json({
    ok: true,
    dataUrl: `data:${outcome.result.mime};base64,${outcome.result.buffer.toString('base64')}`,
  });
}));
