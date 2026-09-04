/**
 * Cross-cutting endpoints: global search, notifications, files, tags,
 * workflows admin, webforms, import/export, and the inventory board.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import os from 'node:os';
import { extname, resolve } from 'node:path';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../../config.js';
import { db, transaction } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { getScope, getUser, requireAuth } from '../../middleware/auth.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../utils/errors.js';
import { assertCapability, canAccessRecord } from '../../core/permissions/index.js';
import { getDriver, getStorageSettings } from '../../core/storage/index.js';
import { buildStorageKey } from '../../core/storage/keys.js';
import {
  ARCHIVE_SETS, contentDisposition, countRecordMedia, safeName, writeRecordArchive,
  type ArchiveSet,
} from '../../core/media/archive.js';
import { applyFileSecurityHeaders } from '../../core/media/serving.js';
import { PHOTO_ORDER } from '../../core/media/ordering.js';
import { recordService } from '../../core/entity/recordService.js';
import { unseenCounts } from '../../core/entity/unseen.js';
import {
  deletePushSubscription, ensureVapidKeys, notify, savePushSubscription,
} from '../../core/notifications/index.js';
import { registry } from '../../core/metadata/registry.js';
import { invalidateWorkflows } from '../../core/workflow/engine.js';
import { runSchedulerNow } from '../../core/workflow/scheduler.js';
import { TASK_TYPES } from '../../core/workflow/tasks.js';
import { mergeRecords } from '../../core/entity/conversion.js';
import { parseCsv } from '../../utils/csv.js';

export const miscRouter = Router();
miscRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// Global search & recents
// ---------------------------------------------------------------------------

miscRouter.get('/search', asyncHandler(async (req, res) => {
  const term = String(req.query.q ?? '').trim();
  if (term.length < 2) { res.json([]); return; }
  res.json(await recordService.globalSearch(getScope(req), term, Math.min(50, Number(req.query.limit) || 20)));
}));

miscRouter.get('/recent', asyncHandler(async (req, res) => {
  const rows = await db.query(
    `SELECT r.id, r.label, r.module_name, r.record_number, rv.viewed_at
     FROM ipy_recent_view rv JOIN ipy_record r ON r.id = rv.record_id
     WHERE rv.user_id = $1 AND r.is_deleted = false
     ORDER BY rv.viewed_at DESC LIMIT 15`,
    [getUser(req).id],
  );
  res.json(rows.rows);
}));

/**
 * Per-module counts of records this user has not opened yet — the sidebar
 * badges. Scoped, so the number only counts records the user can actually open.
 */
miscRouter.get('/unseen-counts', asyncHandler(async (req, res) => {
  res.json(await unseenCounts(getScope(req)));
}));

/**
 * Branding and the company's own social links.
 *
 * Separate from `/api/admin/settings`, which requires the admin.settings
 * capability — every user needs the sidebar's social bar and the brand line,
 * and none of this is sensitive. Writes still go through the admin route.
 */
miscRouter.get('/brand', asyncHandler(async (_req, res) => {
  const rows = await db.query<{ key: string; value: unknown }>(
    `SELECT key, value FROM ipy_setting
     WHERE key IN ('brand.tagline', 'social.links', 'org.name', 'org.logo_url', 'org.phone', 'org.email')`,
  );
  const map = new Map(rows.rows.map((r) => [r.key, r.value]));

  const rawLinks = map.get('social.links');
  const links = Array.isArray(rawLinks) ? rawLinks as { platform?: string; label?: string; url?: string }[] : [];

  res.json({
    orgName: (map.get('org.name') as string) ?? 'iPropy',
    logoUrl: (map.get('org.logo_url') as string) ?? null,
    phone: (map.get('org.phone') as string) ?? null,
    email: (map.get('org.email') as string) ?? null,
    tagline: (map.get('brand.tagline') as string) ?? null,
    // Only http(s) leaves the server: these are admin-editable and end up in an
    // href, where a `javascript:` value would run in the app's origin.
    socialLinks: links
      .filter((l) => typeof l.url === 'string' && /^https?:\/\//i.test(l.url))
      .map((l) => ({ platform: String(l.platform ?? 'link'), label: String(l.label ?? l.platform ?? 'Link'), url: l.url as string })),
  });
}));

// ---------------------------------------------------------------------------
// Browser push — one subscription per device, so a person may hold several
// (laptop Chrome, Android Chrome, iOS home-screen PWA).
// ---------------------------------------------------------------------------

/** Public VAPID key the browser needs to subscribe. Generated on first request. */
miscRouter.get('/push/key', asyncHandler(async (_req, res) => {
  const keys = await ensureVapidKeys();
  res.json({ publicKey: keys.publicKey });
}));

miscRouter.post('/push/subscribe', asyncHandler(async (req, res) => {
  const input = z.object({
    endpoint: z.string().url(),
    keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  }).parse(req.body);

  await savePushSubscription({
    userId: getUser(req).id,
    endpoint: input.endpoint,
    p256dh: input.keys.p256dh,
    auth: input.keys.auth,
    userAgent: req.get('user-agent') ?? undefined,
  });
  res.json({ ok: true });
}));

miscRouter.post('/push/unsubscribe', asyncHandler(async (req, res) => {
  const { endpoint } = z.object({ endpoint: z.string().url() }).parse(req.body);
  await deletePushSubscription(endpoint);
  res.json({ ok: true });
}));

/** Send a test notification to this user's own devices. */
miscRouter.post('/push/test', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const subs = await db.queryOne<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM ipy_push_subscription WHERE user_id = $1`, [user.id],
  );
  if (!subs?.count) {
    res.json({ ok: false, message: 'No devices are subscribed yet — enable notifications first.' });
    return;
  }
  await notify({
    userId: user.id,
    kind: 'test',
    title: 'iPropy test notification',
    body: 'If you can see this, alerts will reach you when a lead arrives.',
    link: '/dashboard',
  });
  res.json({ ok: true, message: `Sent to ${subs.count} device${subs.count === 1 ? '' : 's'}.` });
}));

miscRouter.get('/push/devices', asyncHandler(async (req, res) => {
  const rows = await db.query(
    `SELECT id, user_agent, created_at, last_used_at
     FROM ipy_push_subscription WHERE user_id = $1 ORDER BY created_at DESC`,
    [getUser(req).id],
  );
  res.json(rows.rows);
}));

miscRouter.get('/starred', asyncHandler(async (req, res) => {
  const rows = await db.query(
    `SELECT r.id, r.label, r.module_name, r.record_number
     FROM ipy_starred s JOIN ipy_record r ON r.id = s.record_id
     WHERE s.user_id = $1 AND r.is_deleted = false
     ORDER BY s.created_at DESC LIMIT 50`,
    [getUser(req).id],
  );
  res.json(rows.rows);
}));

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

miscRouter.get('/notifications', asyncHandler(async (req, res) => {
  const unreadOnly = req.query.unread === 'true';
  const rows = await db.query(
    `SELECT id, kind, title, body, link, record_id, is_read, created_at
     FROM ipy_notification
     WHERE user_id = $1 ${unreadOnly ? 'AND is_read = false' : ''}
     ORDER BY created_at DESC LIMIT 60`,
    [getUser(req).id],
  );
  const unread = await db.queryOne<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM ipy_notification WHERE user_id = $1 AND is_read = false`,
    [getUser(req).id],
  );
  res.json({ notifications: rows.rows, unreadCount: unread?.count ?? 0 });
}));

miscRouter.post('/notifications/read', asyncHandler(async (req, res) => {
  const { ids } = z.object({ ids: z.array(z.string().uuid()).optional() }).parse(req.body ?? {});
  if (ids?.length) {
    await db.query(`UPDATE ipy_notification SET is_read = true WHERE user_id = $1 AND id = ANY($2::uuid[])`, [
      getUser(req).id, ids,
    ]);
  } else {
    await db.query(`UPDATE ipy_notification SET is_read = true WHERE user_id = $1 AND is_read = false`, [getUser(req).id]);
  }
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

miscRouter.get('/tags', asyncHandler(async (_req, res) => {
  const rows = await db.query(
    `SELECT t.id, t.name, t.color, COUNT(l.record_id)::int AS usage_count
     FROM ipy_tag t LEFT JOIN ipy_tag_link l ON l.tag_id = t.id
     GROUP BY t.id ORDER BY usage_count DESC, t.name LIMIT 200`,
  );
  res.json(rows.rows);
}));

// ---------------------------------------------------------------------------
// File uploads
// ---------------------------------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// Photos/videos shot on a phone can be huge — several minutes of 4K video
// easily exceeds a GB. Disk-buffered (not memoryStorage) so multer never
// holds the whole upload in process memory during the multipart parse, and
// the route below streams straight from that temp file into storage
// afterward (StorageDriver.save's Readable overload) rather than reading it
// back into a Buffer. Deliberately a separate multer instance from `upload`
// above, which CSV import also uses — this doesn't touch that path at all.
const mediaUpload = multer({
  storage: multer.diskStorage({ destination: os.tmpdir() }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});

const SAFE_EXT = /^\.[a-z0-9]{1,8}$/i;
const MEDIA_MIME_PREFIXES = ['image/', 'video/'];

miscRouter.post('/files', mediaUpload.single('file'), asyncHandler(async (req, res) => {
  const user = getUser(req);
  const scope = getScope(req);
  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) throw new BadRequestError('No file uploaded');

  const recordId = typeof req.body.recordId === 'string' ? req.body.recordId : null;
  const module = typeof req.body.module === 'string' ? req.body.module : null;
  if (recordId && module && !(await canAccessRecord(scope, module, recordId, 'edit'))) {
    await unlink(file.path).catch(() => undefined);
    throw new ForbiddenError('You cannot attach files to this record');
  }

  // Never trust the client's filename for the path — derive a safe key. It is
  // named after the record rather than a bare UUID so that a bucket mirrored to
  // a laptop is browsable; see core/storage/keys.ts.
  const ext = extname(file.originalname).toLowerCase();
  const safeExt = SAFE_EXT.test(ext) ? ext : '';
  const key = await buildStorageKey({ recordId, originalName: file.originalname, ext: safeExt });

  const driver = await getDriver();
  await driver.save(key, createReadStream(file.path), file.mimetype);
  await unlink(file.path).catch(() => undefined);


  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_attachment
       (record_id, file_name, mime_type, size, storage_key, url, category, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      recordId, file.originalname, file.mimetype, file.size, key,
      `/api/files/${key}`, req.body.category ?? null, user.id,
    ],
  );

  // Opt-in replace, for callers that re-send the same file.
  //
  // The automation re-uploads a property's website copies every time somebody
  // presses Finish, and Finish gets pressed again whenever more photos arrive.
  // Without this, each press left another copy of every existing photo: one
  // real property reached four copies of two photos before anyone noticed,
  // because nothing about a duplicate looks like an error.
  //
  // Cleaning up *after* the insert rather than before it, on purpose. Deleting
  // first opens a window where the record has no copy at all, and two runs
  // overlapping in that window leave both of their inserts behind — which is
  // exactly what happened when Finish was pressed twice while the first run was
  // still going. Insert then prune keeps the newest and can never empty it.
  //
  // Deliberately not the default. Someone uploading two genuinely different
  // photos that share a name expects both to survive, and silently discarding
  // one of those would be a worse bug than this one.
  if (row?.id && recordId && String(req.body.replaceExisting) === 'true') {
    await db.query(
      `DELETE FROM ipy_attachment
        WHERE record_id = $1 AND file_name = $2 AND id <> $3`,
      [recordId, file.originalname, row.id],
    );
  }

  // Derivatives (resized images, transcoded video) generate
  // asynchronously so the upload response never waits on processing — see
  // core/media/pipeline.ts, picked up by scheduler.ts's drainMediaQueue.
  if (row?.id && MEDIA_MIME_PREFIXES.some((p) => file.mimetype.startsWith(p))) {
    await db.query(`INSERT INTO ipy_media_job (attachment_id) VALUES ($1)`, [row.id]);
  }

  // A document is read once, on the way in, so it is searchable by what is
  // inside it rather than by its filename. Fired and not awaited: the upload
  // must not wait on a model, and a file that cannot be read is still a file.
  if (row?.id) {
    void import('../../ai/documents.js')
      .then(({ readDocument }) => readDocument(row.id))
      .catch(() => undefined);
  }

  res.status(201).json({
    id: row?.id,
    fileName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
    url: `/api/files/${row?.id}`,
  });
}));

const VARIANT_SIZES = new Set(['thumb', 'medium', 'large']);

miscRouter.get('/files/:id', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const file = await db.queryOne<{
    storage_key: string; file_name: string; mime_type: string; record_id: string | null;
    variants: Record<string, string> | null; uploaded_by: string | null;
  }>(
    `SELECT storage_key, file_name, mime_type, record_id, variants, uploaded_by
       FROM ipy_attachment WHERE id = $1`,
    [req.params.id],
  );
  if (!file) throw new NotFoundError('File not found');

  if (file.record_id) {
    const record = await db.queryOne<{ module_name: string }>(
      `SELECT module_name FROM ipy_record WHERE id = $1`, [file.record_id],
    );
    if (record && !(await canAccessRecord(scope, record.module_name, file.record_id, 'view'))) {
      throw new ForbiddenError();
    }
  }

  // ?size=thumb|medium|large serves a generated derivative when one exists,
  // falling back to the untouched original otherwise (not yet processed, or
  // this attachment never had derivatives — e.g. a PDF).
  // ?download=1 forces a save instead of an in-tab render. The viewer needs
  // both: `inline` for the preview iframe, `attachment` for its download
  // button, and the browser will not re-request the same URL for the other.
  const wantsDownload = req.query.download === '1';

  const requestedSize = typeof req.query.size === 'string' ? req.query.size : null;
  const variantKey = requestedSize && VARIANT_SIZES.has(requestedSize) ? file.variants?.[requestedSize] : undefined;
  const storageKey = variantKey ?? file.storage_key;
  const mimeType = variantKey ? 'image/webp' : file.mime_type;

  const storage = getStorageSettings();
  if (storage.driver === 'local') {
    // Preserve the streaming path for local storage.
    const path = resolve(storage.localPath, storageKey);
    if (!path.startsWith(resolve(storage.localPath))) throw new ForbiddenError();

    applyFileSecurityHeaders(res, mimeType, file.file_name, wantsDownload);
    res.sendFile(path, (err) => {
      if (err) {
        logger.warn({ err, id: req.params.id }, 'file stream failed');
        if (!res.headersSent) res.status(404).json({ error: 'not_found', message: 'File is missing from storage' });
      }
    });
    return;
  }

  const data = await getDriver().then((driver) => driver.read(storageKey));
  if (!data) throw new NotFoundError('File is missing from storage');
  applyFileSecurityHeaders(res, mimeType, file.file_name, wantsDownload);
  res.send(data);
}));

/** Rename or recategorise an attachment without touching its immutable bytes. */
miscRouter.patch('/files/:id', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const input = z.object({
    fileName: z.string().trim().min(1).max(255).optional(),
    category: z.string().trim().max(80).nullable().optional(),
  }).refine((value) => value.fileName !== undefined || value.category !== undefined, {
    message: 'Nothing to update',
  }).parse(req.body);

  const file = await db.queryOne<{
    id: string; record_id: string | null; uploaded_by: string | null;
  }>(`SELECT id, record_id, uploaded_by FROM ipy_attachment WHERE id = $1`, [req.params.id]);
  if (!file) throw new NotFoundError('File not found');

  if (file.record_id) {
    const record = await db.queryOne<{ module_name: string }>(
      `SELECT module_name FROM ipy_record WHERE id = $1 AND is_deleted = false`, [file.record_id],
    );
    if (!record || !(await canAccessRecord(scope, record.module_name, file.record_id, 'edit'))) {
      throw new ForbiddenError('You cannot change files on this record');
    }
  } else if (file.uploaded_by !== scope.user.id && !scope.user.isAdmin) {
    throw new ForbiddenError();
  }

  const row = await db.queryOne(
    `UPDATE ipy_attachment
        SET file_name = COALESCE($2, file_name),
            category = CASE WHEN $3::boolean THEN $4 ELSE category END
      WHERE id = $1
      RETURNING id, file_name, category`,
    [req.params.id, input.fileName ?? null, input.category !== undefined, input.category ?? null],
  );
  res.json(row);
}));

miscRouter.delete('/files/:id', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const file = await db.queryOne<{
    storage_key: string; variants: Record<string, string> | null;
    uploaded_by: string | null; record_id: string | null;
  }>(
    `SELECT storage_key, variants, uploaded_by, record_id FROM ipy_attachment WHERE id = $1`, [req.params.id],
  );
  if (!file) throw new NotFoundError('File not found');
  if (file.record_id) {
    const record = await db.queryOne<{ module_name: string }>(
      `SELECT module_name FROM ipy_record WHERE id = $1 AND is_deleted = false`, [file.record_id],
    );
    if (!record || !(await canAccessRecord(scope, record.module_name, file.record_id, 'edit'))) {
      throw new ForbiddenError('You cannot delete files from this record');
    }
  } else if (file.uploaded_by !== scope.user.id && !scope.user.isAdmin) {
    throw new ForbiddenError();
  }

  const keys = [...new Set([file.storage_key, ...Object.values(file.variants ?? {})])];
  const driver = await getDriver();
  const removed = await Promise.allSettled(keys.map((key) => driver.remove(key)));
  const failure = removed.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) {
    logger.warn({ err: failure.reason, fileId: req.params.id }, 'file delete: storage cleanup failed; retaining CRM row for retry');
    throw failure.reason;
  }
  await db.query(`DELETE FROM ipy_attachment WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

miscRouter.get('/records/:recordId/files', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const record = await db.queryOne<{ module_name: string }>(
    `SELECT module_name FROM ipy_record WHERE id = $1 AND is_deleted = false`,
    [req.params.recordId],
  );
  if (!record) throw new NotFoundError('Record not found');
  if (!(await canAccessRecord(scope, record.module_name, req.params.recordId, 'view'))) {
    throw new ForbiddenError();
  }

  const rows = await db.query(
    `SELECT a.id, a.file_name, a.mime_type, a.size, a.category, a.created_at, a.variants,
            a.stats, a.sort_order,
            a.ai_category, a.ai_caption, a.ai_confidence, a.ai_classified_at,
            trim(u.first_name || ' ' || u.last_name) AS uploaded_by_name
     FROM ipy_attachment a LEFT JOIN ipy_user u ON u.id = a.uploaded_by
     WHERE a.record_id = $1
     ORDER BY ${PHOTO_ORDER}, a.created_at DESC`,
    [req.params.recordId],
  );
  res.json(rows.rows);
}));

/**
 * Arrange a record's photos.
 *
 * The whole list is sent, not a pair of swapped ids: a partial reorder has to
 * be reconciled against positions the client cannot see, and two people
 * arranging the same property would interleave into an order neither chose.
 * Sending the list makes the last save win, visibly and completely — the same
 * reasoning as the sequence-steps editor in outreach.ts.
 *
 * Ids that do not belong to this record are ignored rather than rejected, so a
 * photo deleted in another tab does not fail the save of the other nineteen.
 */
miscRouter.put('/records/:recordId/files/order', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const input = z.object({ ids: z.array(z.string().uuid()).max(500) }).parse(req.body);

  const record = await db.queryOne<{ module_name: string }>(
    `SELECT module_name FROM ipy_record WHERE id = $1 AND is_deleted = false`,
    [req.params.recordId],
  );
  if (!record) throw new NotFoundError('Record not found');
  if (!(await canAccessRecord(scope, record.module_name, req.params.recordId, 'edit'))) {
    throw new ForbiddenError('You cannot arrange files on this record');
  }

  await transaction(async (conn) => {
    for (const [index, id] of input.ids.entries()) {
      await conn.query(
        `UPDATE ipy_attachment SET sort_order = $3 WHERE id = $1 AND record_id = $2`,
        [id, req.params.recordId, index],
      );
    }
  });

  res.json({ ok: true, ordered: input.ids.length });
}));

/**
 * Everything attached to one record, as a zip of ordinary folders.
 *
 * `?set=` picks how much: `branded` (the default) is the full-size web set you
 * would actually send someone, and is small; `all` includes the untouched
 * originals and can be several gigabytes of 4K video, so it is never what you
 * get by accident.
 */
miscRouter.get('/records/:recordId/archive', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const record = await db.queryOne<{ module_name: string }>(
    `SELECT module_name FROM ipy_record WHERE id = $1 AND is_deleted = false`,
    [req.params.recordId],
  );
  if (!record) throw new NotFoundError('Record not found');
  if (!(await canAccessRecord(scope, record.module_name, req.params.recordId, 'view'))) {
    throw new ForbiddenError();
  }

  const requested = String(req.query.set ?? 'branded');
  if (!ARCHIVE_SETS.includes(requested as ArchiveSet)) {
    throw new BadRequestError(`set must be one of: ${ARCHIVE_SETS.join(', ')}`);
  }
  const set = requested as ArchiveSet;

  // Checked before a single byte goes out: past that point the response is
  // already 200 and there is no way left to say "there was nothing here".
  if (await countRecordMedia(req.params.recordId) === 0) {
    throw new NotFoundError('This record has no media to download yet');
  }

  const envelope = await recordService.getRecord(scope, record.module_name, req.params.recordId, { withDisplay: true });
  const module = await registry.requireModule(record.module_name);
  const label = recordService.buildLabel(module, envelope.values as Record<string, unknown>);
  const folder = safeName(label, module.singularLabel);

  // property.json — the record as it stands, so the folder stays meaningful
  // detached from this CRM. Deliberately the display values as well as the raw
  // ones: "₹2.25 Cr" is what a human opening this needs, the number is what a
  // machine importing it needs.
  const manifest = {
    exportedAt: new Date().toISOString(),
    module: record.module_name,
    recordId: req.params.recordId,
    name: label,
    values: envelope.values,
    display: envelope.display ?? null,
  };

  res.setHeader('Content-Type', 'application/zip');
  // Not a plain template string: a property called "Verdant Greens — Tower D"
  // puts a non-Latin-1 character in a header value, which Node rejects and
  // turns into a 500 with no download at all.
  res.setHeader('Content-Disposition', contentDisposition(`${folder}.zip`));
  // Nothing downstream should try to re-encode an already-stored zip.
  res.setHeader('Cache-Control', 'no-store');

  try {
    await writeRecordArchive(req.params.recordId, record.module_name, folder, set, manifest, res);
  } catch (err) {
    // Headers are long gone, so the only honest signal left is an incomplete
    // response — a truncated download the browser reports as failed, rather
    // than a complete-looking zip that is quietly missing photos.
    logger.error({ err, recordId: req.params.recordId }, 'archive: stream failed mid-download');
    res.destroy();
  }
}));

// ---------------------------------------------------------------------------
// Workflows admin
// ---------------------------------------------------------------------------

miscRouter.get('/workflows', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.workflows');
  const rows = await db.query(
    `SELECT w.id, m.name AS module, w.name, w.description, w.trigger, w.watch_fields,
            w.conditions, w.execution_mode, w.schedule, w.is_active, w.is_system,
            w.last_run_at, w.next_run_at, w.run_count, w.sequence,
            (SELECT COUNT(*)::int FROM ipy_workflow_task t WHERE t.workflow_id = w.id) AS task_count
     FROM ipy_workflow w JOIN ipy_module m ON m.id = w.module_id
     ORDER BY m.sequence, w.sequence`,
  );
  res.json({ workflows: rows.rows, taskTypes: TASK_TYPES });
}));

miscRouter.get('/workflows/:id', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.workflows');
  const workflow = await db.queryOne(
    `SELECT w.*, m.name AS module FROM ipy_workflow w JOIN ipy_module m ON m.id = w.module_id WHERE w.id = $1`,
    [req.params.id],
  );
  if (!workflow) throw new NotFoundError('Workflow not found');

  const [tasks, logs] = await Promise.all([
    db.query(`SELECT * FROM ipy_workflow_task WHERE workflow_id = $1 ORDER BY sequence`, [req.params.id]),
    db.query(
      `SELECT id, record_id, status, matched, tasks_run, duration_ms, error, created_at
       FROM ipy_workflow_log WHERE workflow_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.params.id],
    ),
  ]);
  res.json({ ...workflow, tasks: tasks.rows, recentRuns: logs.rows });
}));

const workflowSchema = z.object({
  module: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  trigger: z.string(),
  watchFields: z.array(z.string()).default([]),
  conditions: z.record(z.unknown()).default({ logic: 'AND', conditions: [] }),
  executionMode: z.enum(['always', 'once', 'once_until_false']).default('always'),
  schedule: z.record(z.unknown()).nullable().optional(),
  isActive: z.boolean().default(true),
  tasks: z.array(z.object({
    type: z.string(),
    name: z.string(),
    delayMinutes: z.number().int().min(0).default(0),
    delayField: z.string().nullable().optional(),
    delayDirection: z.enum(['before', 'after']).nullable().optional(),
    config: z.record(z.unknown()).default({}),
    isActive: z.boolean().default(true),
  })).default([]),
});

miscRouter.post('/workflows', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.workflows');
  const input = workflowSchema.parse(req.body);
  const module = await registry.requireModule(input.module);

  const id = await transaction(async (tx) => {
    const row = await tx.queryOne<{ id: string }>(
      `INSERT INTO ipy_workflow
        (module_id, name, description, trigger, watch_fields, conditions,
         execution_mode, schedule, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        module.id, input.name, input.description ?? null, input.trigger,
        JSON.stringify(input.watchFields), JSON.stringify(input.conditions),
        input.executionMode, input.schedule ? JSON.stringify(input.schedule) : null,
        input.isActive, getUser(req).id,
      ],
    );
    for (const [i, task] of input.tasks.entries()) {
      await tx.query(
        `INSERT INTO ipy_workflow_task
          (workflow_id, type, name, sequence, delay_minutes, delay_field, delay_direction, config, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [row!.id, task.type, task.name, i, task.delayMinutes, task.delayField ?? null,
          task.delayDirection ?? null, JSON.stringify(task.config), task.isActive],
      );
    }
    return row!.id;
  });

  invalidateWorkflows();
  res.status(201).json({ id });
}));

miscRouter.put('/workflows/:id', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.workflows');
  const input = workflowSchema.partial().parse(req.body);

  await transaction(async (tx) => {
    const map: Record<string, string> = {
      name: 'name', description: 'description', trigger: 'trigger',
      executionMode: 'execution_mode', isActive: 'is_active',
    };
    const sets: string[] = [];
    const params: unknown[] = [req.params.id];
    for (const [k, v] of Object.entries(input)) {
      if (k === 'tasks' || k === 'module') continue;
      if (k === 'watchFields') { params.push(JSON.stringify(v)); sets.push(`watch_fields = $${params.length}`); continue; }
      if (k === 'conditions') { params.push(JSON.stringify(v)); sets.push(`conditions = $${params.length}`); continue; }
      if (k === 'schedule') { params.push(v ? JSON.stringify(v) : null); sets.push(`schedule = $${params.length}`); continue; }
      const col = map[k];
      if (!col) continue;
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    }
    if (sets.length) {
      await tx.query(`UPDATE ipy_workflow SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
    }
    if (input.tasks) {
      await tx.query(`DELETE FROM ipy_workflow_task WHERE workflow_id = $1`, [req.params.id]);
      for (const [i, task] of input.tasks.entries()) {
        await tx.query(
          `INSERT INTO ipy_workflow_task
            (workflow_id, type, name, sequence, delay_minutes, delay_field, delay_direction, config, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [req.params.id, task.type, task.name, i, task.delayMinutes, task.delayField ?? null,
            task.delayDirection ?? null, JSON.stringify(task.config), task.isActive],
        );
      }
    }
  });

  invalidateWorkflows();
  res.json({ ok: true });
}));

miscRouter.delete('/workflows/:id', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.workflows');
  await db.query(`DELETE FROM ipy_workflow WHERE id = $1`, [req.params.id]);
  invalidateWorkflows();
  res.json({ ok: true });
}));

/** Dry-run a workflow's conditions against a record — no tasks execute. */
miscRouter.post('/workflows/:id/test', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.workflows');
  const { recordId } = z.object({ recordId: z.string().uuid() }).parse(req.body);

  const workflow = await db.queryOne<{ conditions: never; module: string; name: string }>(
    `SELECT w.conditions, m.name AS module, w.name FROM ipy_workflow w
     JOIN ipy_module m ON m.id = w.module_id WHERE w.id = $1`,
    [req.params.id],
  );
  if (!workflow) throw new NotFoundError('Workflow not found');

  const { loadRecordValues } = await import('../../core/workflow/engine.js');
  const { evaluateFilter } = await import('@ipropy/shared');
  const record = await loadRecordValues(workflow.module, recordId);
  if (!record) throw new NotFoundError('Record not found');

  res.json({
    workflow: workflow.name,
    matched: evaluateFilter(workflow.conditions, record, { userId: getUser(req).id }),
    record,
  });
}));

miscRouter.post('/scheduler/run', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.workflows');
  await runSchedulerNow();
  res.json({ ok: true });
}));

miscRouter.get('/queue', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.workflows');
  const rows = await db.query(
    `SELECT q.id, q.status, q.run_at, q.attempts, q.last_error, q.created_at,
            w.name AS workflow_name, t.name AS task_name, t.type AS task_type,
            r.label AS record_label, q.module_name
     FROM ipy_task_queue q
     LEFT JOIN ipy_workflow w ON w.id = q.workflow_id
     LEFT JOIN ipy_workflow_task t ON t.id = q.task_id
     LEFT JOIN ipy_record r ON r.id = q.record_id
     ORDER BY q.run_at DESC LIMIT 100`,
  );
  res.json(rows.rows);
}));

// ---------------------------------------------------------------------------
// Assignment rules
// ---------------------------------------------------------------------------

miscRouter.get('/assignment-rules', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.workflows');
  const rows = await db.query(
    `SELECT ar.*, m.name AS module, g.name AS group_name
     FROM ipy_assignment_rule ar
     JOIN ipy_module m ON m.id = ar.module_id
     LEFT JOIN ipy_group g ON g.id = ar.target_group_id
     ORDER BY m.sequence, ar.sequence`,
  );
  res.json(rows.rows);
}));

miscRouter.post('/assignment-rules', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.workflows');
  const input = z.object({
    module: z.string(),
    name: z.string().min(1),
    conditions: z.record(z.unknown()).default({ logic: 'AND', conditions: [] }),
    strategy: z.enum(['round_robin', 'load_balanced', 'least_busy', 'specific_user', 'group', 'ai_best_fit', 'territory']),
    targetUsers: z.array(z.string().uuid()).default([]),
    targetGroupId: z.string().uuid().nullable().optional(),
    respectCapacity: z.boolean().default(true),
    sequence: z.number().int().default(0),
  }).parse(req.body);

  const module = await registry.requireModule(input.module);
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_assignment_rule
      (module_id, name, conditions, strategy, target_users, target_group_id, respect_capacity, sequence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      module.id, input.name, JSON.stringify(input.conditions), input.strategy,
      JSON.stringify(input.targetUsers), input.targetGroupId ?? null,
      input.respectCapacity, input.sequence,
    ],
  );
  res.status(201).json({ id: row?.id });
}));

miscRouter.delete('/assignment-rules/:id', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.workflows');
  await db.query(`DELETE FROM ipy_assignment_rule WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Web forms
// ---------------------------------------------------------------------------

miscRouter.get('/webforms', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.integrations');
  const rows = await db.query(
    `SELECT w.*, m.name AS module FROM ipy_webform w JOIN ipy_module m ON m.id = w.module_id ORDER BY w.created_at DESC`,
  );
  res.json(rows.rows.map((w) => ({
    ...w,
    embedUrl: `${config.apiUrl}/api/webhooks/forms/${(w as { public_key: string }).public_key}`,
  })));
}));

miscRouter.post('/webforms', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.integrations');
  const input = z.object({
    name: z.string().min(1),
    module: z.string().default('leads'),
    fields: z.array(z.object({
      name: z.string(), label: z.string(), type: z.string().default('text'), required: z.boolean().default(false),
    })).default([]),
    defaults: z.record(z.unknown()).default({}),
    assignToUserId: z.string().uuid().nullable().optional(),
    redirectUrl: z.string().url().nullable().optional(),
    successMessage: z.string().optional(),
    allowedOrigins: z.array(z.string()).default([]),
    notifyUserIds: z.array(z.string().uuid()).default([]),
  }).parse(req.body);

  const module = await registry.requireModule(input.module);
  const publicKey = `ipf_${crypto.randomBytes(12).toString('base64url')}`;

  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_webform
      (name, public_key, module_id, fields, defaults, assign_to_user_id, redirect_url,
       success_message, allowed_origins, notify_user_ids)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [
      input.name, publicKey, module.id, JSON.stringify(input.fields), JSON.stringify(input.defaults),
      input.assignToUserId ?? null, input.redirectUrl ?? null, input.successMessage ?? null,
      JSON.stringify(input.allowedOrigins), JSON.stringify(input.notifyUserIds),
    ],
  );
  res.status(201).json({
    id: row?.id,
    publicKey,
    endpoint: `${config.apiUrl}/api/webhooks/forms/${publicKey}`,
  });
}));

miscRouter.get('/lead-inbox', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.integrations');
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const rows = await db.query(
    `SELECT id, source, external_id, status, error, received_at, processed_at, record_id, normalized
     FROM ipy_lead_inbox ${status ? 'WHERE status = $1' : ''}
     ORDER BY received_at DESC LIMIT 100`,
    status ? [status] : [],
  );
  res.json(rows.rows);
}));

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

miscRouter.post('/import/:module/preview', upload.single('file'), asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'records.import');
  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) throw new BadRequestError('No file uploaded');

  const { headers, rows } = parseCsv(file.buffer.toString('utf8'));
  const module = await registry.requireModule(req.params.module);

  // Suggest a mapping by matching CSV headers against field names and labels.
  const suggestions: Record<string, string> = {};
  for (const header of headers) {
    const norm = header.toLowerCase().replace(/[^a-z0-9]/g, '');
    const match = module.fields.find((f) =>
      f.name.replace(/_/g, '') === norm || f.label.toLowerCase().replace(/[^a-z0-9]/g, '') === norm);
    if (match) suggestions[header] = match.name;
  }

  res.json({
    headers,
    sample: rows.slice(0, 5),
    totalRows: rows.length,
    suggestedMapping: suggestions,
    fields: module.fields
      .filter((f) => f.isActive && !f.isReadonly && f.displayType !== 'hidden')
      .map((f) => ({ name: f.name, label: f.label, uitype: f.uitype, mandatory: f.isMandatory })),
  });
}));

miscRouter.post('/import/:module', upload.single('file'), asyncHandler(async (req, res) => {
  const user = getUser(req);
  const scope = getScope(req);
  await assertCapability(user, 'records.import');
  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) throw new BadRequestError('No file uploaded');

  const mapping = JSON.parse(String(req.body.mapping ?? '{}')) as Record<string, string>;
  const duplicateHandling = String(req.body.duplicateHandling ?? 'skip') as 'skip' | 'overwrite' | 'create';
  // Automations (instant greeting → the outreach queue, scoring, first-call
  // tasks) fire per record through the workflow engine. On a bulk import that
  // meant a queue of hundreds of WhatsApp greetings nobody asked for, and a
  // row-by-row crawl while each one was evaluated. Off by default now; the
  // import form opts in explicitly.
  const runWorkflows = String(req.body.runWorkflows ?? 'false') === 'true';
  const module = await registry.requireModule(req.params.module);
  const { rows } = parseCsv(file.buffer.toString('utf8'));

  const job = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_import_job (module_id, user_id, file_name, mapping, duplicate_handling, status, total_rows)
     VALUES ($1,$2,$3,$4,$5,'running',$6) RETURNING id`,
    [module.id, user.id, file.originalname, JSON.stringify(mapping), duplicateHandling, rows.length],
  );

  // Respond straight away; the import continues in the background.
  res.status(202).json({ jobId: job?.id, totalRows: rows.length });

  void (async () => {
    let created = 0; let skipped = 0; let failed = 0;
    const errors: { row: number; error: string }[] = [];

    for (const [i, raw] of rows.entries()) {
      const values: Record<string, unknown> = {};
      for (const [header, fieldName] of Object.entries(mapping)) {
        if (!fieldName) continue;
        const v = raw[header];
        if (v !== undefined && v !== '') values[fieldName] = v;
      }
      if (!Object.keys(values).length) { skipped++; continue; }

      try {
        await recordService.createRecord(scope, module.name, values, {
          skipDuplicateCheck: duplicateHandling === 'create',
          skipWorkflow: !runWorkflows,
        });
        created++;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error';
        if (duplicateHandling === 'skip' && message.includes('already exists')) {
          skipped++;
        } else {
          failed++;
          if (errors.length < 100) errors.push({ row: i + 2, error: message });
        }
      }

      if (i % 25 === 0) {
        await db.query(
          `UPDATE ipy_import_job SET processed_rows = $2, created_rows = $3, skipped_rows = $4, failed_rows = $5 WHERE id = $1`,
          [job!.id, i + 1, created, skipped, failed],
        ).catch(() => undefined);
      }
    }

    await db.query(
      `UPDATE ipy_import_job
       SET status = 'completed', processed_rows = $2, created_rows = $3, skipped_rows = $4,
           failed_rows = $5, errors = $6, completed_at = now()
       WHERE id = $1`,
      [job!.id, rows.length, created, skipped, failed, JSON.stringify(errors)],
    );

    // An import of any size outlives the page that started it.
    await notify({
      userId: user.id,
      kind: 'import',
      title: 'Import complete',
      body: `${created} created, ${skipped} skipped, ${failed} failed.`,
    });
  })().catch((err) => logger.error({ err }, 'import job failed'));
}));

miscRouter.get('/import/jobs', asyncHandler(async (req, res) => {
  const rows = await db.query(
    `SELECT j.*, m.name AS module FROM ipy_import_job j JOIN ipy_module m ON m.id = j.module_id
     WHERE j.user_id = $1 ORDER BY j.created_at DESC LIMIT 20`,
    [getUser(req).id],
  );
  res.json(rows.rows);
}));

// ---------------------------------------------------------------------------
// Merge duplicates
// ---------------------------------------------------------------------------

miscRouter.post('/merge/:module', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const { primaryId, duplicateIds, fieldChoices } = z.object({
    primaryId: z.string().uuid(),
    duplicateIds: z.array(z.string().uuid()).min(1).max(10),
    fieldChoices: z.record(z.string()).default({}),
  }).parse(req.body);

  for (const id of [primaryId, ...duplicateIds]) {
    if (!(await canAccessRecord(scope, req.params.module, id, 'edit'))) {
      throw new ForbiddenError('You do not have permission to merge these records');
    }
  }

  res.json(await mergeRecords(scope, req.params.module, primaryId, duplicateIds, fieldChoices));
}));
