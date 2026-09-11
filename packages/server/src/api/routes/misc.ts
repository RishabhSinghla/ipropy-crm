/**
 * Cross-cutting endpoints: global search, notifications, files, tags,
 * workflows admin, webforms, import/export, and the inventory board.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import os from 'node:os';
import { extname, resolve, sep } from 'node:path';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../../config.js';
import { db, transaction } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { getScope, getUser, requireAuth } from '../../middleware/auth.js';
import type { AuthUser, FieldMeta } from '@ipropy/shared';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../utils/errors.js';
import {
  assertCapability, assertModuleAccess, canAccessRecord, getFieldPermissions,
} from '../../core/permissions/index.js';
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
import { readImportFile } from '../../core/import/readFile.js';
import { suggestMapping, certainMapping } from '../../core/import/autoMap.js';
import { prepareRow, applyStaticValues } from '../../core/import/prepareRow.js';
import { loadPeople } from '../../core/import/people.js';
import { keepRow, parseFilters } from '../../core/import/rowFilter.js';
import {
  detectTemplate, listTemplates, recordUse, resolveMapping, resolveValues, toFieldIds,
} from '../../core/import/templates.js';
import {
  DEFAULT_CONTEXT, detectDateOrder, normaliseForField,
  type DateOrder, type NormaliseContext,
} from '../../core/import/normalise.js';
import { growPicklists, growableFields } from '../../core/import/picklistGrowth.js';
import { reconcileColumns } from '../../db/seed/reconcileColumns.js';
import {
  pendingDuplicates, resolve as resolveDuplicate, resolveAll, resultCsv,
  type Resolution, type Section,
} from '../../core/import/duplicates.js';

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
     WHERE key IN ('brand.tagline', 'social.links', 'org.name', 'org.logo_url', 'org.phone', 'org.email', 'org.primary_color')`,
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
    // What the admin picked in Brand settings; null means the shipped indigo.
    primaryColor: (map.get('org.primary_color') as string) ?? null,
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
  } else if (file.uploaded_by !== scope.user.id && !scope.user.isAdmin) {
    // An attachment with no record yet — a photo taken but not yet filed, a
    // document mid-upload — belongs to whoever put it there. A guessed UUID
    // is not a grant.
    throw new ForbiddenError();
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
    const root = resolve(storage.localPath);
    const path = resolve(root, storageKey);
    // Separator-aware, like the public route: a bare startsWith(root) would
    // also admit a sibling directory that shares the root as a prefix.
    if (path === root || !path.startsWith(root + sep)) throw new ForbiddenError();

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
    // The page a human fills — same origin as this admin panel (the API serves
    // the SPA in production), unlike embedUrl, which is for the website's
    // server-side proxy and answers JSON.
    formPath: `/f/${(w as { public_key: string }).public_key}`,
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

/**
 * A fill-in template for this module: one column per importable field, with
 * a sample row that is itself a valid record — picklist cells carry a real
 * option value, booleans say "yes", dates are ISO. Upload it unchanged and it
 * simply imports one obviously-sample row; fill it in and it imports yours.
 * Generated from live metadata, so it can never drift from the importer.
 */
/**
 * May this person import into this module?
 *
 * `records.import` says they may import at all; the profile's per-module
 * permission says *where*. Only the first was ever checked here, so the module
 * dropdown correctly hid Properties from somebody allowed only Contacts and
 * the API happily took a file for it anyway — a permission that exists on the
 * screen and nowhere else.
 */
async function assertCanImport(user: AuthUser, moduleName: string): Promise<void> {
  await assertCapability(user, 'records.import');
  await assertModuleAccess(user, moduleName, 'import');
}

/**
 * The fields this person may actually fill from a file.
 *
 * A hidden or read-only field is not an import target, and offering one is
 * worse than useless: the record API refuses the value — correctly — so the
 * column maps to something that quietly does nothing, and the screen has told
 * somebody a field exists that their profile hides from them everywhere else.
 */
async function importableFields(user: AuthUser, moduleName: string): Promise<FieldMeta[]> {
  const module = await registry.requireModule(moduleName);
  const perms = await getFieldPermissions(user, moduleName);
  return module.fields.filter((f) => {
    const permission = perms.get(f.name);
    if (permission === 'hidden' || permission === 'readonly') return false;
    return f.isActive && !f.isReadonly && f.config.importable !== false
      // Unit companions are hidden on the form and are still import targets —
      // a spreadsheet keeps `Area` and `Unit` in two columns.
      && (f.displayType !== 'hidden' || Boolean(f.config.unitMaster));
  });
}

miscRouter.get('/import/:module/template', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCanImport(user, req.params.module);
  const module = await registry.requireModule(req.params.module);

  const fields = module.fields.filter(
    (f) => f.isActive && !f.isReadonly && f.displayType !== 'hidden' && f.config.importable !== false,
  );

  const sampleFor = (f: typeof module.fields[number]): string => {
    switch (f.uitype) {
      case 'picklist':
      case 'radio': return f.options?.find((o) => o.isActive)?.value ?? '';
      case 'multipicklist':
      case 'tags': return (f.options ?? []).filter((o) => o.isActive).slice(0, 2).map((o) => o.value).join('; ');
      case 'boolean': return 'yes';
      case 'date': return '2026-01-15';
      case 'datetime': return '2026-01-15 10:30';
      case 'phone': return '9876543210';
      case 'email': return 'name@example.com';
      case 'url': return 'https://example.com';
      case 'currency': return '1500000';
      case 'area': return '1250';
      case 'integer': case 'decimal': case 'percent': case 'score': return '10';
      case 'string': return 'Sample text';
      case 'textarea': case 'richtext': return 'Sample text';
      // Composite and machine-managed types get no sample: blank is always a
      // valid import, and guessing a shape teaches the wrong format.
      default: return '';
    }
  };

  const escape = (cell: string): string =>
    /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;

  // A required field gets the star. Header matching normalises away
  // everything but letters and numbers, so "Full Name *" still maps to
  // Full Name — the marker teaches without breaking the match.
  const header = fields.map((f) => escape(f.isMandatory ? `${f.label} *` : f.label)).join(',');
  const row = fields.map((f) => escape(sampleFor(f))).join(',');
  // BOM first: Excel only reads the accents in Indian names correctly with it.
  const csv = `\uFEFF${header}\n${row}\n`;

  const safe = module.label.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'import';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}-import-template.csv"`);
  res.send(csv);
}));

miscRouter.post('/import/:module/preview', upload.single('file'), asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCanImport(user, req.params.module);
  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) throw new BadRequestError('No file uploaded');

  const { headers, rows } = readImportFile(file.buffer, file.originalname);
  if (!headers.length) {
    throw new BadRequestError(
      `“${file.originalname}” has no readable header row. The first row must name the columns.`,
    );
  }
  const module = await registry.requireModule(req.params.module);

  /*
    What each column probably is.

    This used to be "the header equals a field name or label once punctuation
    is gone", which on a real file — Customer Name, Mobile No, Requirement,
    Unit — mapped three columns of eight. It also read as
    `(importable && name match) || label match`, so a field marked
    un-importable was still offered whenever its *label* happened to match.

    `suggestedMapping` carries only the guesses safe to fill in for somebody;
    the rest come back in `suggestions` for a person to accept, because a
    silently mis-mapped column writes mobile numbers into a budget field and
    nobody finds out until a report is wrong.
  */
  const allowed = await importableFields(user, req.params.module);
  const suggestionList = suggestMapping(allowed, headers, rows);
  const suggestions = certainMapping(suggestionList);

  // How this file writes its dates, so the wizard can show it and offer to
  // change it rather than deciding silently at import time.
  const dateHeaders = headers.filter((h) => suggestions[h]
    && module.fields.some((f) => f.name === suggestions[h] && (f.uitype === 'date' || f.uitype === 'datetime')));
  const dateOrder = detectDateOrder(rows.flatMap((r) => dateHeaders.map((h) => r[h])));

  /*
    A file the CRM has seen before.

    A saved mapping beats a guess every time — it is what a person decided
    about this exact export — so when the header row matches one, it is offered
    as the starting point and the suggestions stay available underneath.
  */
  const templates = await listTemplates(module.id);
  const hit = detectTemplate(headers, templates);
  const matched = hit && {
    id: hit.template.id,
    name: hit.template.name,
    ...resolveMapping(hit.template.mapping, module.fields),
    staticValues: resolveValues(hit.template.staticValues, module.fields),
    settings: hit.template.settings,
  };

  res.json({
    headers,
    sample: rows.slice(0, 5),
    totalRows: rows.length,
    template: matched,
    templates: templates.map((t) => ({ id: t.id, name: t.name, useCount: t.useCount })),
    suggestedMapping: matched ? { ...suggestions, ...matched.mapping } : suggestions,
    suggestions: suggestionList,
    dateOrder: { detected: dateOrder.order, certain: dateOrder.certain },
    fields: allowed
      // The options travel with the field so the wizard can offer a dropdown's
      // own list where it asks for one fixed value for the whole file. Typing
      // "new" into a free-text box there writes a status no view matches.
      .map((f) => ({
        name: f.name, label: f.label, uitype: f.uitype, mandatory: f.isMandatory,
        options: (f.options ?? []).map((o) => ({ value: o.value, label: o.label })),
      })),
  });
}));

/**
 * What this file will do, before it does anything.
 *
 * The wizard's last screen says "nothing is written until you have seen what
 * it will do", and this is what makes that true. It runs the *same*
 * preparation the import runs — `prepareRow`, the same date order, the same
 * spelling corrections — and then rolls the whole thing back, so the answer on
 * screen is the answer, not a second implementation that agrees most of the
 * time.
 *
 * The rollback is what lets it call `growPicklists` for real: the options a
 * file would add are the ones it names, tombstoned values and all, rather than
 * a guess at what that function decides.
 */
/**
 * The distinct values in each dropdown column, and what they would become.
 *
 * Growing the list automatically is right for a locality — there are hundreds
 * and the file knows them better than the CRM does. It is wrong for a status:
 * a portal export saying "Hot" should become the "High Priority" this team
 * already uses, not a second stage that no view, no report and no automation
 * knows about.
 *
 * Both still happen from one screen. This says what is there; the choice is
 * the admin's, per value.
 */
miscRouter.post('/import/:module/values', upload.single('file'), asyncHandler(async (req, res) => {
  await assertCanImport(getUser(req), req.params.module);
  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) throw new BadRequestError('No file uploaded');
  const mapping = JSON.parse(String(req.body.mapping ?? '{}')) as Record<string, string>;
  const module = await registry.requireModule(req.params.module);
  const { rows } = readImportFile(file.buffer, file.originalname);

  const fold = (v: string): string => v.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  const out: {
    field: string; label: string; header: string; multi: boolean;
    options: { value: string; label: string }[];
    values: { raw: string; count: number; match: string | null }[];
  }[] = [];

  for (const [header, fieldName] of Object.entries(mapping)) {
    if (!fieldName) continue;
    const field = module.fields.find((f) => f.name === fieldName);
    if (!field) continue;
    const listed = field.uitype === 'picklist' || field.uitype === 'radio'
      || field.uitype === 'multipicklist' || field.uitype === 'tags';
    if (!listed) continue;

    const multi = field.uitype === 'multipicklist' || field.uitype === 'tags';
    const options = (field.options ?? []).map((o) => ({ value: o.value, label: o.label }));
    const byFold = new Map(options.map((o) => [fold(o.value), o.value]));

    const counts = new Map<string, number>();
    for (const row of rows) {
      const cell = row[header];
      if (cell === undefined || cell === '') continue;
      for (const part of (multi ? String(cell).split(/[;,]/) : [String(cell)])) {
        const v = part.trim();
        if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
      }
    }

    out.push({
      field: fieldName, label: field.label, header, multi, options,
      values: [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([raw, count]) => ({ raw, count, match: byFold.get(fold(raw)) ?? null })),
    });
  }

  res.json({ columns: out });
}));

miscRouter.post('/import/:module/dry-run', upload.single('file'), asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCanImport(user, req.params.module);
  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) throw new BadRequestError('No file uploaded');

  const mapping = JSON.parse(String(req.body.mapping ?? '{}')) as Record<string, string>;
  const staticValues = JSON.parse(String(req.body.staticValues ?? '{}')) as Record<string, unknown>;
  /*
    What a value in the file means, where somebody has said so.

    Growing the list automatically is right for a locality and wrong for a
    status: "Hot" from a portal export should become the stage this team
    already works, not a second one that no view, report or automation knows
    about.
  */
  const valueMap = JSON.parse(String(req.body.valueMap ?? '{}')) as Record<string, Record<string, string>>;
  const rowFilters = parseFilters(JSON.parse(String(req.body.rowFilters ?? '[]')));
  const importMode = String(req.body.importMode ?? 'create');
  const createOptions = String(req.body.createOptions ?? 'true') !== 'false';
  const module = await registry.requireModule(req.params.module);
  const { headers, rows, widths } = readImportFile(file.buffer, file.originalname);

  const dateColumns = module.fields
    .filter((f) => f.uitype === 'date' || f.uitype === 'datetime').map((f) => f.name);
  const dateSamples: unknown[] = [];
  for (const [header, fieldName] of Object.entries(mapping)) {
    if (!fieldName || !dateColumns.includes(fieldName)) continue;
    for (const row of rows.slice(0, 200)) dateSamples.push(row[header]);
  }
  const requested = String(req.body.dateOrder ?? '').trim();
  const dateOrder = (['dmy', 'mdy', 'ymd'].includes(requested)
    ? requested : detectDateOrder(dateSamples).order ?? 'dmy') as DateOrder;

  const multiValued = new Set(module.fields
    .filter((f) => f.uitype === 'multipicklist' || f.uitype === 'tags').map((f) => f.name));

  let canonical = new Map<string, Map<string, string>>();
  let optionsAdded: string[] = [];
  let optionsSkipped: string[] = [];
  if (createOptions) {
    const seen = new Map<string, Set<string>>();
    const growable = new Set(growableFields(module.fields).map((f) => f.name));
    for (const [ri, raw] of rows.entries()) {
      // A misaligned line teaches the CRM nonsense — "000" as a locality —
      // and it is about to be refused anyway.
      if ((widths?.[ri] ?? 0) > headers.length) continue;
      for (const [header, fieldName] of Object.entries(mapping)) {
        if (!fieldName || !growable.has(fieldName)) continue;
        const cell = raw[header];
        if (cell === undefined || cell === '') continue;
        const bucket = seen.get(fieldName) ?? new Set<string>();
        for (const part of (multiValued.has(fieldName) ? String(cell).split(/[;,]/) : [String(cell)])) {
          const v = part.trim();
          if (!v || valueMap[fieldName]?.[v] !== undefined) continue;
          bucket.add(v);
        }
        seen.set(fieldName, bucket);
      }
    }
    // A sentinel, not a failure: `transaction` rolls back on a throw, which is
    // the only way to ask "what would this write?" of code that writes.
    const ROLLBACK = Symbol('dry run');
    try {
      await transaction(async (tx) => {
        const grown = await growPicklists(module.fields, seen, tx);
        canonical = grown.canonical;
        optionsAdded = grown.result.added;
        optionsSkipped = grown.result.skippedTombstoned;
        throw ROLLBACK;
      });
    } catch (err) {
      if (err !== ROLLBACK) throw err;
    }
  }

  const ctx: NormaliseContext = { ...DEFAULT_CONTEXT, dateOrder };
  // Twenty rows. Enough to see the shape of the file and the first mistakes in
  // it; a preview of four thousand is a second import nobody reads.
  const SHOWN = 20;
  const preview: {
    row: number; outcome: string; matched: string | null;
    values: Record<string, unknown>; problems: string[];
  }[] = [];

  const people = await loadPeople();
  /*
    Filtered rows are counted over the whole file and shown as a number, not
    as rows.

    Twenty rows of "left out" is a preview that tells nobody anything — and it
    is what a filter matching the top of the file would otherwise produce. The
    rows on screen are the first twenty that *survive*, which is what the
    question "what will this do" is actually asking.
  */
  let filtered = 0;
  let filteredBecause = '';
  for (const [i, raw] of rows.entries()) {
    if (preview.length >= SHOWN) break;
    const sheetRow = i + 2;
    const wanted = keepRow(raw, rowFilters, headers);
    if (!wanted.keep) {
      filtered += 1;
      filteredBecause ||= wanted.because;
      continue;
    }
    const { values, unreadable } = prepareRow(raw, {
      mapping, fields: module.fields, canonical, multiValued, ctx, people, valueMap,
    });
    /*
      A line with more values than the heading row is not a row, it is a
      mistake — and the dangerous kind, because the values after the offending
      cell all shift one column left. `₹75,00,000` typed without quotes puts
      "000" in the locality and imports looking perfectly healthy.
    */
    const width = widths?.[i];
    if (width !== undefined && width > headers.length) {
      preview.push({
        row: sheetRow, outcome: 'failed', matched: null, values,
        problems: [`this line has ${width} values where the heading row has ${headers.length}`
          + ' — a comma inside a value needs quotes around it'],
      });
      continue;
    }
    if (unreadable.length) {
      preview.push({ row: sheetRow, outcome: 'failed', matched: null, values, problems: unreadable });
      continue;
    }
    if (!Object.keys(values).length) {
      preview.push({
        row: sheetRow, outcome: 'skipped', matched: null, values,
        problems: ['Every mapped column is empty on this row'],
      });
      continue;
    }
    applyStaticValues(values, staticValues);

    let outcome = 'created';
    let matched: string | null = null;
    if (importMode !== 'create') {
      const existing = await recordService.findDuplicateRecord(module.name, values)
        // Silence here is how an update becomes a second copy of somebody. The
        // row still goes in — refusing the file because the lookup failed is
        // worse — but it is never the quiet answer.
        .catch((err: unknown) => { logger.warn({ err, module: module.name }, 'import: could not check for an existing record'); return null; });
      if (existing) {
        matched = existing.label;
        outcome = importMode === 'skip_existing' ? 'skipped' : 'updated';
      } else if (importMode === 'update') {
        outcome = 'skipped';
      }
    }
    /*
      An owner reads as a person, not as a uuid.

      Everywhere else this screen shows the stored value, because that is the
      point of it. Here the stored value is a foreign key, and "the owner will
      be 8f3c…" answers nobody's question about whether the file is right.
    */
    const display: Record<string, unknown> = { ...values };
    for (const f of module.fields) {
      if ((f.uitype === 'owner' || f.uitype === 'user') && typeof display[f.name] === 'string') {
        display[f.name] = people.names.get(String(display[f.name])) ?? display[f.name];
      }
    }
    preview.push({ row: sheetRow, outcome, matched, problems: [], values: display });
  }

  // The tally of what is left out covers the whole file, not only the part
  // walked to fill the screen.
  if (rowFilters.length) {
    for (const raw of rows.slice(Math.min(rows.length, preview.length + filtered))) {
      const wanted = keepRow(raw, rowFilters, headers);
      if (!wanted.keep) { filtered += 1; filteredBecause ||= wanted.because; }
    }
  }

  res.json({
    totalRows: rows.length, shown: preview.length, dateOrder,
    rows: preview, optionsAdded, optionsSkipped,
    filtered, filteredBecause,
  });
}));

miscRouter.post('/import/:module', upload.single('file'), asyncHandler(async (req, res) => {
  const user = getUser(req);
  const scope = getScope(req);
  await assertCanImport(user, req.params.module);
  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) throw new BadRequestError('No file uploaded');

  const mapping = JSON.parse(String(req.body.mapping ?? '{}')) as Record<string, string>;
  // `review` parks every collision for a person to answer afterwards instead
  // of deciding it now — see core/import/duplicates.ts.
  const duplicateHandling = String(req.body.duplicateHandling ?? 'review') as 'skip' | 'create' | 'review';
  /*
    What this file is for.

    `create` is a new list of people. `update` is a refresh of records that
    already exist and must never invent one. `upsert` is the usual answer for a
    database somebody keeps in Excel — most rows are already here, a few are
    new. `skip_existing` adds only what is missing and leaves the rest alone.

    Update has to look the record up *before* it writes: the create path
    reports a collision by throwing, and by then the record exists and there is
    nothing to take it back.
  */
  const importMode = (['create', 'update', 'upsert', 'skip_existing']
    .includes(String(req.body.importMode ?? '')) ? String(req.body.importMode) : 'create') as
    'create' | 'update' | 'upsert' | 'skip_existing';

  /*
    Values set on every row, whether or not the file has a column for them.

    "This spreadsheet is all Builder Floors from the 99acres export" is a fact
    about the file, not about any row in it, and typing it into 4,000 rows
    first is the kind of thing that makes people give up on an import.
  */
  const staticValues = JSON.parse(String(req.body.staticValues ?? '{}')) as Record<string, unknown>;
  /*
    What a value in the file means, where somebody has said so.

    Growing the list automatically is right for a locality and wrong for a
    status: "Hot" from a portal export should become the stage this team
    already works, not a second one that no view, report or automation knows
    about.
  */
  const valueMap = JSON.parse(String(req.body.valueMap ?? '{}')) as Record<string, Record<string, string>>;
  /*
    Which rows of the file are wanted.

    A portal export holds everything the portal has. The answer otherwise is to
    delete rows in Excel first, which loses the file somebody was sent.
  */
  const rowFilters = parseFilters(JSON.parse(String(req.body.rowFilters ?? '[]')));
  // Automations (instant greeting → the outreach queue, scoring, first-call
  // tasks) fire per record through the workflow engine. On a bulk import that
  // meant a queue of hundreds of WhatsApp greetings nobody asked for, and a
  // row-by-row crawl while each one was evaluated. Off by default now; the
  // import form opts in explicitly.
  const runWorkflows = String(req.body.runWorkflows ?? 'false') === 'true';
  // Which template this run came from, so the list can order by what the team
  // actually uses rather than by when somebody first saved one.
  const templateId = String(req.body.templateId ?? '').trim();
  if (templateId) await recordUse(templateId).catch(() => undefined);
  // On by default, because the alternative is values that import and are then
  // invisible to every filter and view. Off is for an import into a list whose
  // options are a deliberate, closed set.
  const createOptions = String(req.body.createOptions ?? 'true') !== 'false';
  const module = await registry.requireModule(req.params.module);
  const { headers: fileHeaders, rows, widths } = readImportFile(file.buffer, file.originalname);
  if (!rows.length) throw new BadRequestError(`“${file.originalname}” has a header row and no data rows.`);

  /*
    Before a single row is written.

    Both of these used to surface as the same thing: every row failing with a
    raw Postgres sentence. "column \"configuration\" of relation
    \"ipy_e_properties\" does not exist", ten times over, is not something an
    admin can act on — and in that case the fix was not in the file at all.

    1. A field whose metadata says it is a column, on a table that has not got
       that column. `reconcileColumns` puts it back; see its file for the three
       ways the two drift apart. Doing it here rather than only at boot means
       the import that discovered the problem is also the import that fixes it.
    2. A mapped field that is not on this module at all — a mapping saved
       before somebody deleted the field. Named, and refused, rather than
       failing per row.
  */
  await transaction((tx) => reconcileColumns(tx));
  registry.invalidate();
  const live = await registry.requireModule(req.params.module);
  const unknown = [...new Set(Object.values(mapping).filter(Boolean))]
    .filter((name) => !live.fields.some((f) => f.name === name));
  if (unknown.length) {
    throw new BadRequestError(
      `${module.label} has no field named ${unknown.map((u) => `“${u}”`).join(', ')} any more. `
      + 'Re-check the column mapping — the field was probably deleted after this mapping was saved.',
    );
  }

  const job = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_import_job (module_id, user_id, file_name, mapping, duplicate_handling, status, total_rows)
     VALUES ($1,$2,$3,$4,$5,'running',$6) RETURNING id`,
    [module.id, user.id, file.originalname, JSON.stringify(mapping), duplicateHandling, rows.length],
  );

  // Respond straight away; the import continues in the background.
  res.status(202).json({ jobId: job?.id, totalRows: rows.length });

  void (async () => {
    let created = 0; let updated = 0; let skipped = 0; let failed = 0; let duplicates = 0;
    const errors: { row: number; error: string }[] = [];

    /*
      Grow the dropdowns before writing anything.

      A picklist value is a plain string on the record, not a foreign key, so
      an unknown one saves happily and is then invisible to every filter, view
      and report — the value is there and nothing offers it. Adding the options
      up front means the whole file lands as real, selectable values, and the
      first row is judged against the same list as the last.

      `canonical` carries the spelling corrections back: "sector 21" in the
      file becomes "Sector 21" if that option already existed, so one locality
      does not arrive as three.
    */
    let optionsAdded: string[] = [];
    let optionsSkipped: string[] = [];
    let canonical = new Map<string, Map<string, string>>();
    /** The fields whose cell holds a list rather than one value. */
    const multiValued = new Set(
      live.fields.filter((f) => f.uitype === 'multipicklist' || f.uitype === 'tags').map((f) => f.name),
    );
    if (createOptions) {
      try {
        const seen = new Map<string, Set<string>>();
        const growable = new Set(growableFields(live.fields).map((f) => f.name));
        /*
          Only a multi-select cell is split.

          A multi-select holds several values and the template separates them
          with a semicolon, which people also write as a comma. A single
          dropdown holds exactly one — and Faridabad localities are written
          "Ballabgarh, Sector 64". Splitting those would add two options where
          there is one place, and store a value matching neither.
        */
        const multi = multiValued;
        for (const [ri, raw] of rows.entries()) {
          if ((widths?.[ri] ?? 0) > fileHeaders.length) continue;
          for (const [header, fieldName] of Object.entries(mapping)) {
            if (!fieldName || !growable.has(fieldName)) continue;
            const cell = raw[header];
            if (cell === undefined || cell === '') continue;
            const bucket = seen.get(fieldName) ?? new Set<string>();
            const parts = multi.has(fieldName) ? String(cell).split(/[;,]/) : [String(cell)];
            for (const part of parts) {
              const v = part.trim();
              // A value somebody has already answered for is not a new option.
              // Adding "Hot" to the list *and* importing it as High Priority
              // leaves a stage nothing uses sitting in the dropdown forever.
              if (!v || valueMap[fieldName]?.[v] !== undefined) continue;
              bucket.add(v);
            }
            seen.set(fieldName, bucket);
          }
        }
        const grown = await transaction((tx) => growPicklists(live.fields, seen, tx));
        optionsAdded = grown.result.added;
        optionsSkipped = grown.result.skippedTombstoned;
        canonical = grown.canonical;
        if (optionsAdded.length) registry.invalidate();
      } catch (err) {
        // A dropdown that could not grow is not a reason to abandon the file.
        // The values still import; they are simply not offered afterwards.
        logger.warn({ err }, 'could not add dropdown options for this import');
      }
    }
    /*
      How this file writes its dates, decided once for the whole import.

      `03/04/2026` is the third of April to everyone who will use this CRM and
      the fourth of March to `new Date()`, which is what the importer used to
      call. Reading it per row means a column can be interpreted two ways in
      one file; reading it per column, from evidence, means a single
      unambiguous row settles it for the rest. An admin can override it, and
      when nothing in the column proves either way that choice is what stands.
    */
    const dateColumns = live.fields
      .filter((f) => f.uitype === 'date' || f.uitype === 'datetime')
      .map((f) => f.name);
    const dateSamples: unknown[] = [];
    for (const [header, fieldName] of Object.entries(mapping)) {
      if (!fieldName || !dateColumns.includes(fieldName)) continue;
      for (const row of rows.slice(0, 200)) dateSamples.push(row[header]);
    }
    const detected = detectDateOrder(dateSamples);
    const requestedOrder = String(req.body.dateOrder ?? '').trim();
    const dateOrder: DateOrder = (['dmy', 'mdy', 'ymd'].includes(requestedOrder)
      ? requestedOrder
      : detected.order ?? 'dmy') as DateOrder;
    const normaliseCtx: NormaliseContext = { ...DEFAULT_CONTEXT, dateOrder };
    logger.info({ dateOrder, certain: detected.certain, requested: requestedOrder || null },
      'import: date order for this file');

    // What the counts are made of, shown when a number is clicked in the UI.
    // Bounded: a five-figure import does not need five-figure lists in one
    // jsonb cell, so each list stops at 300 and the UI says so.
    const CAP = 300;
    const details: { created: string[]; skipped: string[]; optionsAdded: string[]; optionsSkipped: string[] } =
      { created: [], skipped: [], optionsAdded, optionsSkipped };
    let cancelled = false;

    const people = await loadPeople();
    for (const [i, raw] of rows.entries()) {
      // Asked before any work is done on the row: a file where four fifths of
      // the rows are filtered out should cost a fifth of the time.
      const wanted = keepRow(raw, rowFilters, fileHeaders);
      if (!wanted.keep) {
        skipped++;
        if (details.skipped.length < CAP) details.skipped.push(`row ${i + 2} — left out, ${wanted.because}`);
        await logRow(job!.id, i + 2, 'skipped', {}, { message: `left out — ${wanted.because}` });
        continue;
      }
      const { values, unreadable } = prepareRow(raw, {
        mapping, fields: live.fields, canonical, multiValued, ctx: normaliseCtx, people, valueMap,
      });
      // See the same check in the rehearsal above: a line wider than the
      // heading row has every value after the unquoted comma in the wrong
      // column, and importing it is worse than refusing it.
      const width = widths?.[i];
      if (width !== undefined && width > fileHeaders.length) {
        failed++;
        const why = `this line has ${width} values where the heading row has ${fileHeaders.length}`
          + ' — a comma inside a value needs quotes around it';
        if (errors.length < 100) errors.push({ row: i + 2, error: why });
        await logRow(job!.id, i + 2, 'failed', values, { message: why });
        continue;
      }
      if (unreadable.length) {
        failed++;
        const why = unreadable.join('; ');
        if (errors.length < 100) errors.push({ row: i + 2, error: why });
        await logRow(job!.id, i + 2, 'failed', values, { message: why });
        continue;
      }
      if (!Object.keys(values).length) {
        skipped++;
        await logRow(job!.id, i + 2, 'skipped', {}, { message: 'Every mapped column was empty on this row' });
        continue;
      }

      // The line number as the user sees it in Excel: the header is line 1.
      const sheetRow = i + 2;
      const rowName = String(values.full_name ?? values.name ?? Object.values(values)[0] ?? `row ${sheetRow}`);

      applyStaticValues(values, staticValues);

      if (importMode !== 'create') {
        const existing = await recordService.findDuplicateRecord(module.name, values)
        // Silence here is how an update becomes a second copy of somebody. The
        // row still goes in — refusing the file because the lookup failed is
        // worse — but it is never the quiet answer.
        .catch((err: unknown) => { logger.warn({ err, module: module.name }, 'import: could not check for an existing record'); return null; });
        if (existing) {
          if (importMode === 'skip_existing') {
            skipped++;
            if (details.skipped.length < CAP) details.skipped.push(`${rowName} — already here`);
            await logRow(job!.id, sheetRow, 'skipped', values, { label: rowName, message: 'already here' });
            continue;
          }
          try {
            await recordService.updateRecord(scope, module.name, existing.id, values, { skipWorkflow: !runWorkflows });
            updated++;
            await logRow(job!.id, sheetRow, 'updated', values, { recordId: existing.id, label: existing.label });
          } catch (err) {
            failed++;
            const message = err instanceof Error ? err.message : 'unknown error';
            if (errors.length < 100) errors.push({ row: sheetRow, error: message });
            await logRow(job!.id, sheetRow, 'failed', values, { label: rowName, message });
          }
          continue;
        }
        if (importMode === 'update') {
          // Update-only must not invent a record. Saying so is the point: a
          // file that matches nothing is usually mapped to the wrong column.
          skipped++;
          if (details.skipped.length < CAP) details.skipped.push(`${rowName} — no matching record to update`);
          await logRow(job!.id, sheetRow, 'skipped', values, { label: rowName, message: 'no matching record to update' });
          continue;
        }
      }

      try {
        const envelope = await recordService.createRecord(scope, module.name, values, {
          skipDuplicateCheck: duplicateHandling === 'create',
          skipWorkflow: !runWorkflows,
        });
        created++;
        if (details.created.length < CAP) {
          details.created.push(String(envelope.label ?? envelope.id));
        }
        await logRow(job!.id, sheetRow, 'created', values, {
          recordId: envelope.id, label: String(envelope.label ?? ''),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error';
        const conflict = err instanceof ConflictError
          ? (err.details as { duplicateId?: string; duplicateLabel?: string } | undefined)
          : undefined;

        if (conflict?.duplicateId && duplicateHandling === 'review') {
          // Parked, not decided. It counts as neither created nor skipped
          // until somebody has looked at it.
          duplicates++;
          await logRow(job!.id, sheetRow, 'duplicate', values, {
            label: rowName, message, existingId: conflict.duplicateId,
          });
        } else if (duplicateHandling === 'skip' && message.includes('already exists')) {
          skipped++;
          if (details.skipped.length < CAP) {
            details.skipped.push(`${rowName} — ${message}`);
          }
          await logRow(job!.id, sheetRow, 'skipped', values, { label: rowName, message });
        } else {
          failed++;
          if (errors.length < 100) errors.push({ row: sheetRow, error: message });
          await logRow(job!.id, sheetRow, 'failed', values, { label: rowName, message });
        }
      }

      // Progress every row: the screen reads like a live thing, not a report.
      // The guard on status doubles as the cancel signal — a cancelled job's
      // row no longer matches `running`, so the loop stops on its next write.
      const step = await db.query(
        `UPDATE ipy_import_job
         SET processed_rows = $2, created_rows = $3, skipped_rows = $4, failed_rows = $5,
             details = $6::jsonb, duplicate_rows = $7, pending_rows = $7, updated_rows = $8
         WHERE id = $1 AND status = 'running'
         RETURNING id`,
        [job!.id, i + 1, created, skipped, failed, JSON.stringify(details), duplicates, updated],
      ).catch(() => undefined);
      if (step && step.rowCount === 0) { cancelled = true; break; }
    }

    await db.query(
      `UPDATE ipy_import_job
       SET status = $6, processed_rows = $2, created_rows = $3, skipped_rows = $4,
           failed_rows = $5, errors = $7, duplicate_rows = $8, pending_rows = $8,
           updated_rows = $9, completed_at = now()
       WHERE id = $1`,
      [job!.id, rows.length, created, skipped, failed, cancelled ? 'cancelled' : 'completed',
        JSON.stringify(errors), duplicates, updated],
    );

    // An import of any size outlives the page that started it.
    await notify({
      userId: user.id,
      kind: 'import',
      title: cancelled ? 'Import cancelled' : 'Import complete',
      body: [
        duplicates > 0
          ? `${created} created, ${skipped} skipped, ${failed} failed — ${duplicates} need a decision.`
          : `${created} created, ${skipped} skipped, ${failed} failed.`,
        optionsAdded.length
          ? `${optionsAdded.length} new dropdown option${optionsAdded.length === 1 ? '' : 's'} added.`
          : '',
      ].filter(Boolean).join(' '),
    });
  })().catch((err) => logger.error({ err }, 'import job failed'));
}));

/**
 * One line of the import's own record of what it did.
 *
 * Written per row rather than only counted, because two things need the detail
 * and neither can be reconstructed afterwards: the duplicate-review screen,
 * which has to show the incoming values beside the record they collided with,
 * and the downloadable result, which has to hold every row rather than the
 * first 300 `ipy_import_job.details` can carry.
 *
 * Never allowed to break the import. A failed audit write is worth a log line;
 * it is not worth abandoning a file halfway through.
 */
async function logRow(
  jobId: string,
  rowNumber: number,
  outcome: 'created' | 'updated' | 'skipped' | 'failed' | 'duplicate',
  values: Record<string, unknown>,
  extra: { recordId?: string; label?: string; message?: string; existingId?: string } = {},
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO ipy_import_row (job_id, row_number, outcome, values, record_id, label, message, existing_id)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)`,
      [jobId, rowNumber, outcome, JSON.stringify(values),
        extra.recordId ?? null, extra.label ?? null, extra.message ?? null, extra.existingId ?? null],
    );
  } catch (err) {
    logger.warn({ err, jobId, rowNumber }, 'could not record import row');
  }
}

/** The job, if it belongs to the caller. Every route below needs exactly this. */
async function ownedJob(req: Parameters<typeof getUser>[0], jobId: string): Promise<{ id: string; module: string }> {
  const job = await db.queryOne<{ id: string; module: string }>(
    `SELECT j.id, m.name AS module
       FROM ipy_import_job j JOIN ipy_module m ON m.id = j.module_id
      WHERE j.id = $1 AND j.user_id = $2`,
    [jobId, getUser(req).id],
  );
  if (!job) throw new NotFoundError('No import with that id');
  return job;
}

/**
 * The duplicates this job parked, each beside the record it collided with.
 *
 * Deliberately not paginated. A file that produces hundreds of collisions is
 * telling you the whole file is a re-import, and the answer to that is "skip
 * them all" at the top of the screen — not thirty pages of side-by-side
 * comparison.
 */
miscRouter.get('/import/jobs/:id/duplicates', asyncHandler(async (req, res) => {
  const job = await ownedJob(req, req.params.id);
  res.json({
    module: job.module,
    pairs: await pendingDuplicates(getScope(req), job.id, job.module),
  });
}));

/** Answer one parked duplicate: merge, skip, or create it as a second record. */
miscRouter.post('/import/jobs/:id/duplicates/:rowId', asyncHandler(async (req, res) => {
  const job = await ownedJob(req, req.params.id);
  const { action, fieldChoices } = z.object({
    action: z.enum(['merged', 'skipped', 'created']),
    fieldChoices: z.record(z.enum(['incoming', 'existing'])).default({}),
  }).parse(req.body);

  res.json(await resolveDuplicate(
    getScope(req), job.id, req.params.rowId, action as Resolution, fieldChoices, job.module,
  ));
}));

/** Answer every remaining duplicate the same way. */
miscRouter.post('/import/jobs/:id/duplicates', asyncHandler(async (req, res) => {
  const job = await ownedJob(req, req.params.id);
  const { action } = z.object({ action: z.enum(['merged', 'skipped', 'created']) }).parse(req.body);
  res.json(await resolveAll(getScope(req), job.id, action as Resolution, job.module));
}));

/**
 * The result as a sheet.
 *
 * One file per outcome rather than one workbook with three tabs: this is CSV,
 * which has no tabs, and inventing a single file with a mixed shape to stand
 * in for them would be worse than four honest downloads. `all` is the fourth —
 * every row, with its outcome in a column, which is the one you filter and
 * pivot.
 */
miscRouter.get('/import/jobs/:id/result.csv', asyncHandler(async (req, res) => {
  const job = await ownedJob(req, req.params.id);
  const section = (['created', 'updated', 'skipped', 'failed', 'duplicates', 'all'] as const)
    .find((s) => s === req.query.section) ?? 'all';

  const csv = await resultCsv(job.id, section as Section, job.module);
  const name = String(req.query.name ?? 'import').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name || 'import'}-${section}.csv"`);
  res.send(csv);
}));

miscRouter.post('/import/jobs/:id/cancel', asyncHandler(async (req, res) => {
  // Sets the flag the worker watches; the worker does the stopping, on its
  // next row, so nothing is killed mid-write.
  const result = await db.query(
    `UPDATE ipy_import_job SET status = 'cancelling'
     WHERE id = $1 AND user_id = $2 AND status = 'running'
     RETURNING id`,
    [req.params.id, getUser(req).id],
  );
  if (!result.rowCount) throw new NotFoundError('No running import with that id');
  res.json({ ok: true });
}));

/**
 * Undo an import.
 *
 * What this can honestly do is remove the records the import *created*. An
 * update overwrote values that were never kept anywhere, so there is nothing
 * to put back — and a button that says "Undo" and silently leaves half the
 * damage is worse than no button. The response says exactly what it did, and
 * the screen repeats it before asking.
 *
 * Records are deleted the normal way, through `recordService`, so the audit
 * trail, the workflows and the recycle bin all behave as they do for a person
 * deleting a record — and anything already deleted, or since merged away, is
 * counted as gone rather than treated as a failure.
 */
miscRouter.post('/import/jobs/:id/rollback', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const scope = getScope(req);
  await assertCapability(user, 'records.import');

  const job = await db.queryOne<{ id: string; module: string; status: string; user_id: string }>(
    `SELECT j.id, m.name AS module, j.status, j.user_id
       FROM ipy_import_job j JOIN ipy_module m ON m.id = j.module_id
      WHERE j.id = $1`, [req.params.id]);
  if (!job) throw new NotFoundError('No import with that id');
  // Somebody else's import is somebody else's decision. An admin who needs to
  // undo one can delete the records; this button is not the place to let one
  // person reverse another's work without their knowing.
  if (job.user_id !== user.id) throw new ForbiddenError('That import was run by somebody else');
  if (job.status === 'running' || job.status === 'cancelling') {
    throw new BadRequestError('Cancel the import first — it is still adding rows');
  }

  const created = await db.query<{ record_id: string }>(
    `SELECT record_id FROM ipy_import_row
      WHERE job_id = $1 AND outcome = 'created' AND record_id IS NOT NULL`, [job.id]);

  let deleted = 0;
  let gone = 0;
  const failures: string[] = [];
  for (const row of created.rows) {
    try {
      await recordService.deleteRecord(scope, job.module, row.record_id);
      deleted += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      if (err instanceof NotFoundError) { gone += 1; continue; }
      if (failures.length < 20) failures.push(message);
    }
  }

  const updated = await db.queryOne<{ n: string }>(
    `SELECT count(*)::text AS n FROM ipy_import_row WHERE job_id = $1 AND outcome = 'updated'`, [job.id]);

  logger.info({ jobId: job.id, deleted, gone, failed: failures.length }, 'import rolled back');
  res.json({ deleted, gone, failed: failures.length, failures, keptUpdates: Number(updated?.n ?? 0) });
}));

miscRouter.get('/import/:module/templates', asyncHandler(async (req, res) => {
  await assertCanImport(getUser(req), req.params.module);
  const module = await registry.requireModule(req.params.module);
  const templates = await listTemplates(module.id);
  res.json(templates.map((t) => ({
    id: t.id, name: t.name, headers: t.headers, useCount: t.useCount, lastUsedAt: t.lastUsedAt,
    ...resolveMapping(t.mapping, module.fields),
    staticValues: resolveValues(t.staticValues, module.fields),
    settings: t.settings,
  })));
}));

/**
 * Save this mapping under a name.
 *
 * Field *ids* are stored, not names — see core/import/templates.ts. Saving the
 * same name twice overwrites, because "Save as 99acres export" said twice in a
 * month means the export changed, not that the team wants two of them.
 */
miscRouter.post('/import/:module/templates', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCanImport(user, req.params.module);
  const module = await registry.requireModule(req.params.module);
  const body = z.object({
    name: z.string().trim().min(1).max(80),
    headers: z.array(z.string()).default([]),
    mapping: z.record(z.string()).default({}),
    staticValues: z.record(z.unknown()).default({}),
    settings: z.record(z.unknown()).default({}),
  }).parse(req.body);

  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_import_template (module_id, name, headers, mapping, static_values, settings, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (module_id, lower(name)) DO UPDATE
       SET headers = EXCLUDED.headers, mapping = EXCLUDED.mapping,
           static_values = EXCLUDED.static_values, settings = EXCLUDED.settings
     RETURNING id`,
    [module.id, body.name, body.headers,
      JSON.stringify(toFieldIds(body.mapping, module.fields, 'value')),
      JSON.stringify(toFieldIds(body.staticValues, module.fields, 'key')),
      JSON.stringify(body.settings), user.id],
  );
  res.status(201).json({ id: row!.id, name: body.name });
}));

miscRouter.delete('/import/:module/templates/:id', asyncHandler(async (req, res) => {
  await assertCanImport(getUser(req), req.params.module);
  const done = await db.query(`DELETE FROM ipy_import_template WHERE id = $1 RETURNING id`,
    [req.params.id]);
  if (!done.rowCount) throw new NotFoundError('No template with that id');
  res.json({ ok: true });
}));

miscRouter.get('/import/jobs', asyncHandler(async (req, res) => {
  const rows = await db.query(
    `SELECT j.*, m.name AS module, m.label AS module_label
     FROM ipy_import_job j JOIN ipy_module m ON m.id = j.module_id
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
