/**
 * Cross-cutting endpoints: global search, notifications, files, tags,
 * workflows admin, webforms, import/export, and the inventory board.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
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
import { recordService } from '../../core/entity/recordService.js';
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

const SAFE_EXT = /^\.[a-z0-9]{1,8}$/i;

miscRouter.post('/files', upload.single('file'), asyncHandler(async (req, res) => {
  const user = getUser(req);
  const scope = getScope(req);
  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) throw new BadRequestError('No file uploaded');

  const recordId = typeof req.body.recordId === 'string' ? req.body.recordId : null;
  const module = typeof req.body.module === 'string' ? req.body.module : null;
  if (recordId && module && !(await canAccessRecord(scope, module, recordId, 'edit'))) {
    throw new ForbiddenError('You cannot attach files to this record');
  }

  // Never trust the client's filename for the path — derive a safe key.
  const ext = extname(file.originalname).toLowerCase();
  const safeExt = SAFE_EXT.test(ext) ? ext : '';
  const key = `${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}${safeExt}`;

  await getDriver().then((driver) => driver.save(key, file.buffer, file.mimetype));

  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_attachment (record_id, file_name, mime_type, size, storage_key, url, category, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      recordId, file.originalname, file.mimetype, file.size, key,
      `/api/files/${key}`, req.body.category ?? null, user.id,
    ],
  );

  res.status(201).json({
    id: row?.id,
    fileName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
    url: `/api/files/${row?.id}`,
  });
}));

miscRouter.get('/files/:id', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const file = await db.queryOne<{ storage_key: string; file_name: string; mime_type: string; record_id: string | null }>(
    `SELECT storage_key, file_name, mime_type, record_id FROM ipy_attachment WHERE id = $1`,
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

  const storage = getStorageSettings();
  if (storage.driver === 'local') {
    // Preserve the streaming path for local storage.
    const path = resolve(storage.localPath, file.storage_key);
    if (!path.startsWith(resolve(storage.localPath))) throw new ForbiddenError();

    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.file_name)}"`);
    res.sendFile(path, (err) => {
      if (err) {
        logger.warn({ err, id: req.params.id }, 'file stream failed');
        if (!res.headersSent) res.status(404).json({ error: 'not_found', message: 'File is missing from storage' });
      }
    });
    return;
  }

  const data = await getDriver().then((driver) => driver.read(file.storage_key));
  if (!data) throw new NotFoundError('File is missing from storage');
  res.setHeader('Content-Type', file.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.file_name)}"`);
  res.send(data);
}));

miscRouter.delete('/files/:id', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const file = await db.queryOne<{ storage_key: string; uploaded_by: string | null }>(
    `SELECT storage_key, uploaded_by FROM ipy_attachment WHERE id = $1`, [req.params.id],
  );
  if (!file) throw new NotFoundError('File not found');
  if (file.uploaded_by !== user.id && !user.isAdmin) throw new ForbiddenError();

  await db.query(`DELETE FROM ipy_attachment WHERE id = $1`, [req.params.id]);
  await getDriver().then((driver) => driver.remove(file.storage_key));
  res.json({ ok: true });
}));

miscRouter.get('/records/:recordId/files', asyncHandler(async (req, res) => {
  const rows = await db.query(
    `SELECT a.id, a.file_name, a.mime_type, a.size, a.category, a.created_at,
            trim(u.first_name || ' ' || u.last_name) AS uploaded_by_name
     FROM ipy_attachment a LEFT JOIN ipy_user u ON u.id = a.uploaded_by
     WHERE a.record_id = $1 ORDER BY a.created_at DESC`,
    [req.params.recordId],
  );
  res.json(rows.rows);
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
  const { evaluateFilter } = await import('../../core/query/evaluate.js');
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

    await db.query(
      `INSERT INTO ipy_notification (user_id, kind, title, body)
       VALUES ($1,'import','Import complete',$2)`,
      [user.id, `${created} created, ${skipped} skipped, ${failed} failed.`],
    );
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

// ---------------------------------------------------------------------------
// Inventory board — the grid view sales teams actually use
// ---------------------------------------------------------------------------

miscRouter.get('/inventory/:projectId', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  if (!(await canAccessRecord(scope, 'projects', req.params.projectId, 'view'))) throw new ForbiddenError();

  const units = await db.query(
    `SELECT p.record_id AS id, r.label, p.tower, p.floor, p.unit_number, p.configuration,
            p.status, p.carpet_area, p.total_price, p.base_price, p.facing, p.corner_unit,
            p.blocked_until, p.blocked_for_lead_id, r.owner_id,
            bl.label AS blocked_for_label
     FROM ipy_e_properties p
     JOIN ipy_record r ON r.id = p.record_id
     LEFT JOIN ipy_record bl ON bl.id = p.blocked_for_lead_id
     WHERE p.project_id = $1 AND r.is_deleted = false
     ORDER BY p.tower NULLS LAST, p.floor DESC NULLS LAST, p.unit_number`,
    [req.params.projectId],
  );

  const summary = await db.query<{ status: string; count: number; value: number }>(
    `SELECT p.status, COUNT(*)::int AS count, COALESCE(SUM(p.total_price),0)::numeric AS value
     FROM ipy_e_properties p JOIN ipy_record r ON r.id = p.record_id
     WHERE p.project_id = $1 AND r.is_deleted = false GROUP BY p.status`,
    [req.params.projectId],
  );

  // Group into towers → floors so the client renders a stack plan directly.
  const towers = new Map<string, Map<number, unknown[]>>();
  for (const unit of units.rows) {
    const tower = String((unit as { tower?: string }).tower ?? 'Tower');
    const floor = Number((unit as { floor?: number }).floor ?? 0);
    if (!towers.has(tower)) towers.set(tower, new Map());
    const floors = towers.get(tower)!;
    if (!floors.has(floor)) floors.set(floor, []);
    floors.get(floor)!.push(unit);
  }

  res.json({
    summary: summary.rows,
    total: units.rows.length,
    towers: [...towers.entries()].map(([name, floors]) => ({
      name,
      floors: [...floors.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([floor, list]) => ({ floor, units: list })),
    })),
  });
}));

/** Block / release a unit — the action reps take from the inventory board. */
miscRouter.post('/inventory/:propertyId/block', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const scope = getScope(req);
  await assertCapability(user, 'inventory.block_unit');

  const { leadId, days, release } = z.object({
    leadId: z.string().uuid().nullable().optional(),
    days: z.number().int().min(1).max(90).default(7),
    release: z.boolean().default(false),
  }).parse(req.body);

  const current = await db.queryOne<{ status: string }>(
    `SELECT status FROM ipy_e_properties WHERE record_id = $1`, [req.params.propertyId],
  );
  if (!current) throw new NotFoundError('Unit not found');

  if (!release && !['Available', 'Held'].includes(current.status)) {
    throw new BadRequestError(`This unit is ${current.status} and cannot be blocked.`);
  }

  await recordService.updateRecord(scope, 'properties', req.params.propertyId, release
    ? { status: 'Available', blocked_until: null, blocked_for_lead_id: null, blocked_by: null }
    : {
        status: 'Blocked',
        blocked_until: new Date(Date.now() + days * 86_400_000).toISOString(),
        blocked_for_lead_id: leadId ?? null,
        blocked_by: user.id,
      });

  res.json({ ok: true, status: release ? 'Available' : 'Blocked' });
}));
