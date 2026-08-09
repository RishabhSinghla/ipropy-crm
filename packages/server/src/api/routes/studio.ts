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
import type { AuthUser } from '@ipropy/shared';
import { db } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { getScope, getUser, requireAuth } from '../../middleware/auth.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../utils/errors.js';
import { queueRender } from '../../core/media/renderQueue.js';
import { isFfmpegAvailable, isReelMusicAvailable } from '../../core/media/reel.js';
import { editImage, isImageEditAvailable, listPresets, type EditPreset } from '../../ai/imageEdit.js';
import { getDriver } from '../../core/storage/index.js';
import { assertCapability, hasCapability } from '../../core/permissions/index.js';
import { recordService } from '../../core/entity/recordService.js';
import { resolveImageSources } from '../../core/media/source.js';

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

studioRouter.get('/capabilities', asyncHandler(async (req, res) => {
  const user = getUser(req);
  res.json({
    video: await isFfmpegAvailable(),
    music: await isReelMusicAvailable(),
    imageEdit: isImageEditAvailable() && await hasCapability(user, 'ai.use'),
    brochure: true,
    presets: listPresets(),
  });
}));

// ---------------------------------------------------------------------------
// Designs
// ---------------------------------------------------------------------------

studioRouter.get('/designs', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const { kind, recordId } = z.object({
    kind: z.enum(['post', 'reel', 'brochure']).optional(),
    recordId: z.string().uuid().optional(),
  }).parse(req.query);

  const clauses: string[] = ['(d.created_by = $1 OR $2)'];
  const params: unknown[] = [user.id, user.isAdmin];
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
  const design = await requireDesignAccess(req.params.id, getUser(req));
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
  if (input.recordId) {
    await recordService.getRecord(getScope(req), input.module ?? 'properties', input.recordId);
  }
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_design
      (name, kind, template_key, record_id, module_name, width, height, spec, thumbnail, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [
      input.name, input.kind, input.templateKey ?? null, input.recordId ?? null,
      input.module ?? null, input.width, input.height,
      JSON.stringify(stripAccessTokens(input.spec)), input.thumbnail ?? null, user.id,
    ],
  );
  res.status(201).json({ id: row?.id });
}));

studioRouter.patch('/designs/:id', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await requireDesignAccess(req.params.id, user, true);
  const input = designSchema.partial().parse(req.body);
  if (input.recordId) {
    await recordService.getRecord(getScope(req), input.module ?? 'properties', input.recordId);
  }
  const map: Record<string, string> = {
    name: 'name', kind: 'kind', templateKey: 'template_key', recordId: 'record_id',
    module: 'module_name', width: 'width', height: 'height', spec: 'spec', thumbnail: 'thumbnail',
  };
  const sets: string[] = [];
  const params: unknown[] = [req.params.id];
  for (const [key, value] of Object.entries(input)) {
    const col = map[key];
    if (!col) continue;
    params.push(col === 'spec' ? JSON.stringify(stripAccessTokens(value)) : value);
    sets.push(`${col} = $${params.length}`);
  }
  if (sets.length) {
    await db.query(`UPDATE ipy_design SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
  }
  res.json({ ok: true });
}));

studioRouter.delete('/designs/:id', asyncHandler(async (req, res) => {
  await requireDesignAccess(req.params.id, getUser(req), true);
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
  const job = await requireRenderAccess(req.params.id, getUser(req));
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
  const job = await requireRenderAccess(req.params.id, getUser(req)) as {
    output_key: string | null; output_mime: string | null; kind: string;
  };
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
    width: z.number().int().min(360).max(2160).default(1080),
    height: z.number().int().min(640).max(3840).default(1920),
    music: z.boolean().default(false),
    recordId: z.string().uuid(),
    slides: z.array(z.object({
      url: z.string().min(1).max(500),
      caption: z.string().max(120).optional(),
    })).min(1).max(20),
  }).parse(req.body);

  if (!(await isFfmpegAvailable())) {
    throw new BadRequestError(
      'Video rendering needs ffmpeg installed on the server. Posts and brochures still work without it.',
      { capability: 'video' },
    );
  }

  await recordService.getRecord(getScope(req), 'properties', input.recordId);
  const slides = await resolveImageSources(input.slides, input.recordId);
  const { recordId, ...rest } = input;
  res.status(202).json(await queueRender({
    kind: 'reel', spec: { ...rest, slides }, recordId, requestedBy: user.id,
  }));
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
      url: z.string().min(1).max(500),
      caption: z.string().max(120).optional(),
    })).max(12).default([]),
    brandColour: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    orgName: z.string().max(80).optional(),
    phone: z.string().max(40).optional(),
    website: z.string().max(120).optional(),
    recordId: z.string().uuid(),
  }).parse(req.body);

  await recordService.getRecord(getScope(req), 'properties', input.recordId);
  const photos = await resolveImageSources(input.photos, input.recordId);
  const { recordId, ...rest } = input;
  res.status(202).json(await queueRender({
    kind: 'brochure', spec: { ...rest, photos }, recordId, requestedBy: user.id,
  }));
}));

// ---------------------------------------------------------------------------
// AI photo editing
// ---------------------------------------------------------------------------

studioRouter.post('/image-edit', upload.single('image'), asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'ai.use');
  const input = z.object({
    preset: z.enum(['virtual_stage', 'declutter', 'sky_replace', 'enhance', 'daylight', 'custom']),
    instruction: z.string().max(600).optional(),
    // Alternative to a multipart upload: an existing attachment.
    attachmentId: z.string().uuid().optional(),
  }).parse(req.body);

  let image: Buffer | null = req.file?.buffer ?? null;
  if (req.file && !req.file.mimetype.startsWith('image/')) {
    throw new BadRequestError('The uploaded file must be an image');
  }

  if (!image && input.attachmentId) {
    const attachment = await db.queryOne<{ storage_key: string; record_id: string | null; module_name: string | null; mime_type: string }>(
      `SELECT a.storage_key, a.record_id, r.module_name, a.mime_type
       FROM ipy_attachment a LEFT JOIN ipy_record r ON r.id = a.record_id
       WHERE a.id = $1`,
      [input.attachmentId],
    );
    if (attachment) {
      if (!attachment.mime_type.startsWith('image/')) throw new BadRequestError('That attachment is not an image');
      if (attachment.record_id && attachment.module_name) {
        await recordService.getRecord(getScope(req), attachment.module_name, attachment.record_id);
      } else if (!user.isAdmin) {
        throw new ForbiddenError('That attachment is not linked to an accessible record');
      }
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

async function requireDesignAccess(id: string, user: AuthUser, _write = false): Promise<Record<string, unknown>> {
  const design = await db.queryOne<Record<string, unknown> & { created_by: string | null }>(
    `SELECT * FROM ipy_design WHERE id = $1`,
    [id],
  );
  if (!design) throw new NotFoundError('Design not found');
  if (!user.isAdmin && design.created_by !== user.id) {
    throw new ForbiddenError('You can only access designs you created');
  }
  return design;
}

async function requireRenderAccess(id: string, user: AuthUser): Promise<Record<string, unknown>> {
  const job = await db.queryOne<Record<string, unknown> & { requested_by: string | null }>(
    `SELECT * FROM ipy_render_job WHERE id = $1`,
    [id],
  );
  if (!job) throw new NotFoundError('Render not found');
  if (!user.isAdmin && job.requested_by !== user.id) {
    throw new ForbiddenError('You cannot access this render');
  }
  return job;
}

/** Never persist bearer tokens embedded in authenticated file preview URLs. */
function stripAccessTokens(value: unknown): unknown {
  if (typeof value === 'string' && value.includes('access_token=')) {
    try {
      const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
      const parsed = new URL(value, 'http://ipropy.local');
      parsed.searchParams.delete('access_token');
      return absolute ? parsed.toString() : `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return value.replace(/([?&])access_token=[^&#]*&?/g, '$1').replace(/[?&]$/, '');
    }
  }
  if (Array.isArray(value)) return value.map(stripAccessTokens);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, stripAccessTokens(item)]));
  }
  return value;
}
