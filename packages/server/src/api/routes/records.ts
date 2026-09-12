import { Router } from 'express';
import { logger } from '../../utils/logger.js';
import { z } from 'zod';
import { createShareLink, listShareLinks, revokeShareLink } from '../../core/sharing/shareLinks.js';
import type { FilterGroup, ListQuery } from '@ipropy/shared';
import { db, transaction } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { blockApiKey, getScope, getUser, requireAuth } from '../../middleware/auth.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../utils/errors.js';
import { registry } from '../../core/metadata/registry.js';
import { recordService } from '../../core/entity/recordService.js';
import {
  assertCapability, assertModuleAccess, canAccessRecord, getFieldPermissions,
  getModulePermission,
} from '../../core/permissions/index.js';
import { buildTimeline } from '../../core/entity/timeline.js';
import { filterUnseen, markModuleSeen } from '../../core/entity/unseen.js';
import { toCsv } from '../../utils/csv.js';
import { notifyMany } from '../../core/notifications/index.js';
import { buildExport, resolveExportColumns, type ExportColumn } from '../../core/export/engine.js';

export const recordsRouter = Router();
recordsRouter.use(requireAuth);

/**
 * A connected app can read, create and update. It can never delete.
 *
 * Deletion is the one action with no undo from the far side of an assistant:
 * a misread instruction that updates a status is a mistake somebody notices
 * and reverses, and one that empties a list is a restore-from-backup. The line
 * is drawn here rather than by choosing which tools to publish, because the key
 * can be pointed at any client, not just the one we wrote.
 */
recordsRouter.use((req, res, next) => {
  const destructive = req.method === 'DELETE' || req.path.endsWith('/mass-delete');
  return destructive ? blockApiKey(req, res, next) : next();
});

const filterSchema: z.ZodType<FilterGroup> = z.lazy(() =>
  z.object({
    logic: z.enum(['AND', 'OR']),
    conditions: z.array(
      z.union([
        z.object({
          field: z.string(),
          operator: z.string(),
          value: z.unknown().optional(),
          value2: z.unknown().optional(),
          path: z.string().optional(),
        }),
        filterSchema,
      ]),
    ),
  }) as z.ZodType<FilterGroup>,
);

const listSchema = z.object({
  view: z.string().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(500).optional(),
  sortBy: z.string().optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  search: z.string().optional(),
  filter: filterSchema.optional(),
  columns: z.array(z.string()).optional(),
  groupBy: z.string().optional(),
  includeDeleted: z.coerce.boolean().optional(),
});

/** GET/POST share a body-or-query parsing path so complex filters can use POST. */
function parseListInput(req: { query: unknown; body: unknown; method: string }): z.infer<typeof listSchema> {
  if (req.method === 'POST') return listSchema.parse(req.body ?? {});
  const q = req.query as Record<string, unknown>;
  const parsed: Record<string, unknown> = { ...q };
  if (typeof q.filter === 'string') {
    try { parsed.filter = JSON.parse(q.filter); } catch { throw new BadRequestError('filter must be valid JSON'); }
  }
  if (typeof q.columns === 'string') parsed.columns = q.columns.split(',').map((s) => s.trim()).filter(Boolean);
  return listSchema.parse(parsed);
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

recordsRouter.get('/:module', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const input = parseListInput(req);
  const result = await recordService.listRecords(scope, req.params.module, input);
  res.json(result);
}));

/**
 * Which of these records this user has not opened yet — the bold-row state.
 *
 * Takes ids the caller already holds from a list response, so it inherits that
 * response's permission filtering instead of re-deriving it. Kept off the list
 * endpoint itself so exports, reports and widgets don't pay for a join they
 * have no use for.
 */
recordsRouter.post('/:module/unseen', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertModuleAccess(user, req.params.module, 'view');
  const { ids } = z.object({ ids: z.array(z.string().uuid()).max(500) }).parse(req.body);
  res.json({ unseen: await filterUnseen(user.id, req.params.module, ids) });
}));

/** Move this user's watermark to now — "mark all as seen" for one module. */
recordsRouter.post('/:module/seen', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertModuleAccess(user, req.params.module, 'view');
  await markModuleSeen(user.id, req.params.module);
  res.json({ ok: true });
}));

// POST /search for filters too complex for a query string.
recordsRouter.post('/:module/search', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const input = parseListInput(req);
  res.json(await recordService.listRecords(scope, req.params.module, input));
}));

// ---------------------------------------------------------------------------
// Lookup (reference pickers, AI tools)
// ---------------------------------------------------------------------------

recordsRouter.get('/:module/lookup', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const term = String(req.query.q ?? '');
  const limit = Math.min(50, Number(req.query.limit) || 20);
  let filter: FilterGroup | undefined;
  if (typeof req.query.filter === 'string') {
    try { filter = JSON.parse(req.query.filter) as FilterGroup; } catch { /* ignore bad filter */ }
  }
  res.json(await recordService.lookupRecords(scope, req.params.module, term, limit, filter));
}));

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

recordsRouter.get('/:module/export', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const scope = getScope(req);
  const moduleName = req.params.module;
  const perm = await getModulePermission(user, moduleName);
  if (!perm.export) throw new ForbiddenError('You do not have permission to export this module');

  const module = await registry.requireModule(moduleName);
  const input = parseListInput(req);
  const columns = input.columns?.length
    ? input.columns
    : module.fields.filter((f) => f.isActive && f.displayType !== 'hidden').slice(0, 40).map((f) => f.name);

  const result = await recordService.listRecords(scope, moduleName, {
    ...input, page: 1, pageSize: 5000,
  });

  const fieldLabels = new Map(module.fields.map((f) => [f.name, f.label]));
  const csv = toCsv(
    result.rows.map((r) => {
      const row: Record<string, unknown> = {};
      for (const c of columns) {
        row[fieldLabels.get(c) ?? c] = r.display?.[c] ?? r.values[c] ?? '';
      }
      return row;
    }),
  );

  await recordService.writeAudit(db, {
    recordId: null, module: moduleName, userId: user.id, action: 'export',
    changes: [{ count: result.rows.length }], source: 'app',
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${moduleName}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

/**
 * Export wizard endpoint. The legacy GET CSV link above remains for old list
 * URLs; every new export comes through here with Field IDs and an explicit
 * format. Records are always fetched through recordService, so filters and
 * field-level permissions are identical to the list the user is looking at.
 */
recordsRouter.post('/:module/export', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const scope = getScope(req);
  const moduleName = req.params.module;
  const perm = await getModulePermission(user, moduleName);
  if (!perm.export) throw new ForbiddenError('You do not have permission to export this module');
  const input = z.object({
    format: z.enum(['csv', 'xlsx']).default('xlsx'),
    columns: z.array(z.object({ fieldId: z.string().regex(/^fld_[A-Za-z0-9]+$/), header: z.string().max(120).optional() })).max(200).optional(),
    filter: filterSchema.optional(),
    selectedIds: z.array(z.string().uuid()).max(5000).optional(),
    sortBy: z.string().optional(),
    sortDir: z.enum(['asc', 'desc']).optional(),
  }).parse(req.body ?? {});
  const module = await registry.requireModule(moduleName);
  const columns = resolveExportColumns(module, input.columns as ExportColumn[] | undefined);
  if (!columns.length) throw new BadRequestError('Choose at least one field to export.');
  /*
    Fetched in pages until the list is exhausted, not in one capped read.

    A single `pageSize: 5000` looks fine on today's data and silently drops the
    rest the moment the business outgrows it — an export that quietly stops at
    row 5,000 is indistinguishable from a complete one, and "export everything"
    is precisely when nobody counts. `EXPORT_MAX_ROWS` is a real ceiling, and
    when it bites the response says so instead of leaving it to be discovered
    in the spreadsheet.
  */
  const EXPORT_PAGE = 1000;
  const EXPORT_MAX_ROWS = 100_000;
  const selected = input.selectedIds?.length ? new Set(input.selectedIds) : null;
  const rows: Awaited<ReturnType<typeof recordService.listRecords>>['rows'] = [];
  let truncated = false;
  for (let page = 1; ; page += 1) {
    const result = await recordService.listRecords(scope, moduleName, {
      filter: input.filter,
      sortBy: input.sortBy,
      sortDir: input.sortDir,
      page,
      pageSize: EXPORT_PAGE,
    });
    rows.push(...(selected ? result.rows.filter((row) => selected.has(row.id)) : result.rows));
    if (result.rows.length < EXPORT_PAGE) break;
    if (rows.length >= EXPORT_MAX_ROWS) { truncated = true; break; }
    // Every wanted record is already in hand; no need to walk the rest.
    if (selected && rows.length >= selected.size) break;
  }
  if (truncated) {
    logger.warn({ module: moduleName, userId: user.id, rows: rows.length }, 'export hit the row ceiling and was truncated');
    res.setHeader('X-Export-Truncated', String(EXPORT_MAX_ROWS));
  }
  const file = await buildExport(input.format, columns, rows);
  await recordService.writeAudit(db, {
    recordId: null, module: moduleName, userId: user.id, action: 'export',
    changes: [{ count: rows.length, format: input.format, fields: columns.map((c) => c.field.internalId) }], source: 'app',
  });
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${moduleName}-${new Date().toISOString().slice(0, 10)}.${file.extension}"`);
  res.send(file.content);
}));

/** Read the current user's decisions for a match list, so the actions remain
 * meaningful after closing/reopening a record rather than disappearing. */
recordsRouter.get('/:module/:id/matches/feedback', asyncHandler(async (req, res) => {
  const user = getUser(req); const scope = getScope(req);
  await assertModuleAccess(user, req.params.module, 'view');
  if (!(await canAccessRecord(scope, req.params.module, req.params.id, 'view'))) throw new NotFoundError('Record not found');
  const rows = await db.query<{ targetId: string; decision: 'shortlisted' | 'not_suitable' | 'follow_up' }>(
    `SELECT target_record_id AS "targetId", decision FROM ipy_match_feedback
      WHERE source_record_id = $1 AND decided_by = $2`, [req.params.id, user.id],
  );
  res.json(rows.rows);
}));

/** Store a salesperson's shortlist/follow-up/not-suitable decision on a match. */
recordsRouter.post('/:module/:id/matches/:targetId/feedback', asyncHandler(async (req, res) => {
  const user = getUser(req); const scope = getScope(req);
  await assertModuleAccess(user, req.params.module, 'edit');
  if (!(await canAccessRecord(scope, req.params.module, req.params.id, 'view'))) throw new NotFoundError('Record not found');
  const { decision } = z.object({ decision: z.enum(['shortlisted', 'not_suitable', 'follow_up']) }).parse(req.body);
  const target = await db.queryOne<{ module_name: string }>(`SELECT module_name FROM ipy_record WHERE id = $1 AND is_deleted = false`, [req.params.targetId]);
  if (!target || !(await canAccessRecord(scope, target.module_name, req.params.targetId, 'view'))) throw new NotFoundError('Matching record not found');
  await db.query(
    `INSERT INTO ipy_match_feedback (source_record_id, target_record_id, decision, decided_by, decided_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (source_record_id, target_record_id) DO UPDATE SET decision = EXCLUDED.decision, decided_by = EXCLUDED.decided_by, decided_at = now()`,
    [req.params.id, req.params.targetId, decision, user.id],
  );
  res.json({ ok: true, decision });
}));

/** A match action is a reversible working decision, not a permanent verdict. */
recordsRouter.delete('/:module/:id/matches/:targetId/feedback', asyncHandler(async (req, res) => {
  const user = getUser(req); const scope = getScope(req);
  await assertModuleAccess(user, req.params.module, 'edit');
  if (!(await canAccessRecord(scope, req.params.module, req.params.id, 'view'))) throw new NotFoundError('Record not found');
  await db.query(
    `DELETE FROM ipy_match_feedback WHERE source_record_id = $1 AND target_record_id = $2 AND decided_by = $3`,
    [req.params.id, req.params.targetId, user.id],
  );
  res.json({ ok: true });
}));

/** Saved exports retain Field IDs, so a field rename never breaks a template. */
recordsRouter.get('/:module/export/templates', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const module = await registry.requireModule(req.params.module);
  const perm = await getModulePermission(user, module.name);
  if (!perm.export) throw new ForbiddenError('You do not have permission to export this module');
  const rows = await db.query(
    `SELECT id, name, columns, filter, is_default AS "isDefault", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM ipy_export_template WHERE module_id = $1 ORDER BY is_default DESC, name`, [module.id],
  );
  res.json(rows.rows);
}));

recordsRouter.post('/:module/export/templates', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const module = await registry.requireModule(req.params.module);
  const perm = await getModulePermission(user, module.name);
  if (!perm.export) throw new ForbiddenError('You do not have permission to export this module');
  const input = z.object({
    name: z.string().min(1).max(120),
    columns: z.array(z.object({ fieldId: z.string().regex(/^fld_[A-Za-z0-9]+$/), header: z.string().max(120).optional() })).min(1).max(200),
    filter: filterSchema.optional(), isDefault: z.boolean().default(false),
  }).parse(req.body ?? {});
  if (resolveExportColumns(module, input.columns).length !== input.columns.length) {
    throw new BadRequestError('One or more selected fields are no longer available to export.');
  }
  const row = await transaction(async (tx) => {
    if (input.isDefault) await tx.query(`UPDATE ipy_export_template SET is_default = false WHERE module_id = $1`, [module.id]);
    return tx.queryOne<{ id: string }>(
      `INSERT INTO ipy_export_template (module_id, name, columns, filter, is_default, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [module.id, input.name, JSON.stringify(input.columns), input.filter ? JSON.stringify(input.filter) : null, input.isDefault, user.id],
    );
  });
  res.status(201).json({ id: row!.id });
}));

recordsRouter.patch('/:module/export/templates/:id', asyncHandler(async (req, res) => {
  const user = getUser(req); const module = await registry.requireModule(req.params.module);
  if (!(await getModulePermission(user, module.name)).export) throw new ForbiddenError('You do not have permission to export this module');
  const input = z.object({ name: z.string().min(1).max(120).optional(), columns: z.array(z.object({ fieldId: z.string().regex(/^fld_[A-Za-z0-9]+$/), header: z.string().max(120).optional() })).min(1).max(200).optional(), filter: filterSchema.optional(), isDefault: z.boolean().optional() }).parse(req.body ?? {});
  if (input.columns && resolveExportColumns(module, input.columns).length !== input.columns.length) throw new BadRequestError('One or more selected fields are no longer available to export.');
  await transaction(async (tx) => {
    const template = await tx.queryOne<{ id: string }>(`SELECT id FROM ipy_export_template WHERE id = $1 AND module_id = $2`, [req.params.id, module.id]);
    if (!template) throw new NotFoundError('Export template not found');
    if (input.isDefault) await tx.query(`UPDATE ipy_export_template SET is_default = false WHERE module_id = $1`, [module.id]);
    const sets: string[] = ['updated_at = now()']; const params: unknown[] = [req.params.id];
    if (input.name !== undefined) { params.push(input.name); sets.push(`name = $${params.length}`); }
    if (input.columns !== undefined) { params.push(JSON.stringify(input.columns)); sets.push(`columns = $${params.length}`); }
    if (input.filter !== undefined) { params.push(JSON.stringify(input.filter)); sets.push(`filter = $${params.length}`); }
    if (input.isDefault !== undefined) { params.push(input.isDefault); sets.push(`is_default = $${params.length}`); }
    await tx.query(`UPDATE ipy_export_template SET ${sets.join(', ')} WHERE id = $1`, params);
  });
  res.json({ ok: true });
}));

recordsRouter.delete('/:module/export/templates/:id', asyncHandler(async (req, res) => {
  const user = getUser(req); const module = await registry.requireModule(req.params.module);
  if (!(await getModulePermission(user, module.name)).export) throw new ForbiddenError('You do not have permission to export this module');
  const result = await db.query(`DELETE FROM ipy_export_template WHERE id = $1 AND module_id = $2`, [req.params.id, module.id]);
  if (!result.rowCount) throw new NotFoundError('Export template not found');
  res.status(204).end();
}));

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

recordsRouter.post('/:module', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const body = z.record(z.unknown()).parse(req.body ?? {});
  const record = await recordService.createRecord(scope, req.params.module, body);
  res.status(201).json(record);
}));

// ---------------------------------------------------------------------------
// Duplicate check (called live from the create form)
// ---------------------------------------------------------------------------

recordsRouter.post('/:module/check-duplicates', asyncHandler(async (req, res) => {
  const { values, excludeId } = z.object({
    values: z.record(z.unknown()),
    excludeId: z.string().uuid().optional(),
  }).parse(req.body);
  res.json(await recordService.findPossibleDuplicates(req.params.module, values, excludeId));
}));

// ---------------------------------------------------------------------------
// Bulk operations (before /:id so they aren't captured as an id)
// ---------------------------------------------------------------------------

recordsRouter.post('/:module/mass-update', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'records.mass_edit');
  const { ids, values, runWorkflows } = z.object({
    ids: z.array(z.string().uuid()).min(1).max(500),
    values: z.record(z.unknown()),
    // Off unless asked for. See recordService.massUpdate for why a bulk tidy-up
    // that fires every new-lead automation is the failure, not the feature.
    runWorkflows: z.boolean().default(false),
  }).parse(req.body);
  res.json(await recordService.massUpdate(getScope(req), req.params.module, ids, values, { runWorkflows }));
}));

/**
 * Bulk edit every record the current view/filter matches — Gmail's "select all
 * conversations in this search", for records. The query arrives exactly as the
 * list screen sent it, so what gets edited is what the user was looking at.
 */
recordsRouter.post('/:module/mass-update-all', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'records.mass_edit');
  await assertModuleAccess(user, req.params.module, 'edit');
  const { query, values, runWorkflows } = z.object({
    query: z.object({
      view: z.string().uuid().optional(),
      filter: z.unknown().optional(),
      search: z.string().optional(),
    }).passthrough(),
    values: z.record(z.unknown()),
    runWorkflows: z.boolean().default(false),
  }).parse(req.body);
  res.json(await recordService.massUpdateByQuery(
    getScope(req), req.params.module, query as ListQuery, values, { runWorkflows }));
}));

recordsRouter.post('/:module/mass-delete', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'records.mass_delete');
  const { ids } = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) }).parse(req.body);
  res.json(await recordService.massDelete(getScope(req), req.params.module, ids));
}));

recordsRouter.post('/:module/transfer', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'records.transfer_ownership');
  const { ids, ownerId, ownerType } = z.object({
    ids: z.array(z.string().uuid()).min(1).max(1000),
    ownerId: z.string().uuid(),
    ownerType: z.enum(['user', 'group']).default('user'),
  }).parse(req.body);
  const count = await recordService.transferOwnership(getScope(req), req.params.module, ids, ownerId, ownerType);
  res.json({ transferred: count });
}));

/** Reassign every record the view/filter matches — the select-all companion. */
recordsRouter.post('/:module/transfer-all', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'records.transfer_ownership');
  await assertModuleAccess(user, req.params.module, 'edit');
  const { query, ownerId, ownerType } = z.object({
    query: z.object({}).passthrough(),
    ownerId: z.string().uuid(),
    ownerType: z.enum(['user', 'group']).default('user'),
  }).parse(req.body);
  const ids = await recordService.idsForQuery(getScope(req), req.params.module, query as ListQuery);
  const count = await recordService.transferOwnership(getScope(req), req.params.module, ids, ownerId, ownerType);
  res.json({ transferred: count, matched: ids.length });
}));

// Move a contact into Inventory, or an inventory unit into Leads. The service
// creates the destination record and only then removes the source record, all
// in one transaction, so a failed move never makes a row disappear.
recordsRouter.post('/:module/:id/move', asyncHandler(async (req, res) => {
  const { targetModule } = z.object({ targetModule: z.enum(['leads', 'properties']) }).parse(req.body ?? {});
  res.status(201).json(await recordService.moveRecord(getScope(req), req.params.module, req.params.id, targetModule));
}));

// ---------------------------------------------------------------------------
// Single record
// ---------------------------------------------------------------------------

recordsRouter.get('/:module/:id', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const user = getUser(req);
  const { module, id } = req.params;

  const record = await recordService.getRecord(scope, module, id);

  // Attach what this user may do, so the UI can hide impossible actions.
  const [canEdit, canDelete] = await Promise.all([
    canAccessRecord(scope, module, id, 'edit'),
    canAccessRecord(scope, module, id, 'delete'),
  ]);
  record.can = { view: true, edit: canEdit, delete: canDelete, share: canEdit };

  // Track recently-viewed for the global switcher.
  await db.query(
    `INSERT INTO ipy_recent_view (user_id, record_id, viewed_at) VALUES ($1,$2,now())
     ON CONFLICT (user_id, record_id) DO UPDATE SET viewed_at = now()`,
    [user.id, id],
  ).catch(() => undefined);

  const [tags, starred] = await Promise.all([
    db.query<{ name: string }>(
      `SELECT t.name FROM ipy_tag t JOIN ipy_tag_link l ON l.tag_id = t.id WHERE l.record_id = $1`, [id],
    ),
    db.queryOne(`SELECT 1 FROM ipy_starred WHERE user_id = $1 AND record_id = $2`, [user.id, id]),
  ]);
  record.tags = tags.rows.map((t) => t.name);
  record.starred = Boolean(starred);

  res.json(record);
}));

recordsRouter.patch('/:module/:id', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const body = z.record(z.unknown()).parse(req.body ?? {});
  res.json(await recordService.updateRecord(scope, req.params.module, req.params.id, body));
}));

recordsRouter.put('/:module/:id', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const body = z.record(z.unknown()).parse(req.body ?? {});
  res.json(await recordService.updateRecord(scope, req.params.module, req.params.id, body));
}));

recordsRouter.delete('/:module/:id', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const hard = req.query.hard === 'true' && getUser(req).isAdmin;
  await recordService.deleteRecord(scope, req.params.module, req.params.id, { hard });
  res.json({ ok: true });
}));

recordsRouter.post('/:module/:id/restore', asyncHandler(async (req, res) => {
  await recordService.restoreRecord(getScope(req), req.params.module, req.params.id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Timeline, comments, related lists
// ---------------------------------------------------------------------------

recordsRouter.get('/:module/:id/timeline', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const { module, id } = req.params;
  if (!(await canAccessRecord(scope, module, id, 'view'))) throw new ForbiddenError();
  const limit = Math.min(200, Number(req.query.limit) || 60);
  const types = typeof req.query.types === 'string' ? req.query.types.split(',') : undefined;
  res.json(await buildTimeline(id, { limit, types }));
}));

recordsRouter.get('/:module/:id/comments', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  if (!(await canAccessRecord(scope, req.params.module, req.params.id, 'view'))) throw new ForbiddenError();
  const rows = await db.query(
    `SELECT c.id, c.parent_id, c.user_id, c.body, c.mentions, c.is_private, c.created_at, c.updated_at,
            c.edit_history, trim(u.first_name || ' ' || u.last_name) AS user_name, u.avatar_url AS user_avatar
     FROM ipy_comment c JOIN ipy_user u ON u.id = c.user_id
     WHERE c.record_id = $1
     ORDER BY c.created_at DESC`,
    [req.params.id],
  );
  res.json(rows.rows);
}));

recordsRouter.post('/:module/:id/comments', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const user = getUser(req);
  const { module, id } = req.params;
  if (!(await canAccessRecord(scope, module, id, 'view'))) throw new ForbiddenError();

  const { body, parentId, isPrivate, mentions } = z.object({
    body: z.string().min(1).max(10_000),
    parentId: z.string().uuid().optional(),
    isPrivate: z.boolean().optional(),
    mentions: z.array(z.string().uuid()).optional(),
  }).parse(req.body);

  const row = await db.queryOne<{ id: string; created_at: string }>(
    `INSERT INTO ipy_comment (record_id, parent_id, user_id, body, mentions, is_private)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
    [id, parentId ?? null, user.id, body, JSON.stringify(mentions ?? []), isPrivate ?? false],
  );

  // Notify anyone @mentioned. notifyMany de-duplicates, so naming somebody
  // twice in one comment still only pings them once.
  await notifyMany((mentions ?? []).filter((m) => m !== user.id), {
    kind: 'mention',
    title: `${user.fullName} mentioned you`,
    body: body.slice(0, 200),
    link: `/${module}/${id}`,
    recordId: id,
  });

  await recordService.touchActivity(id);
  res.status(201).json({ id: row?.id, createdAt: row?.created_at });
}));

/**
 * Edit a note you wrote.
 *
 * The author (or an admin) may fix a note after posting. The previous text is
 * kept in `edit_history` — an edit is honest when what was there before is
 * still readable, the way message apps show it, not a silent overwrite of what
 * a colleague may already have read and acted on.
 */
recordsRouter.patch('/:module/:id/comments/:commentId', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const user = getUser(req);
  if (!(await canAccessRecord(scope, req.params.module, req.params.id, 'view'))) throw new ForbiddenError();

  const { body, mentions } = z.object({
    body: z.string().min(1).max(10_000),
    mentions: z.array(z.string().uuid()).optional(),
  }).parse(req.body);

  const existing = await db.queryOne<{ user_id: string; body: string; mentions: unknown; edit_history: { body: string; at: string }[] }>(
    `SELECT user_id, body, mentions, edit_history FROM ipy_comment WHERE id = $1 AND record_id = $2`,
    [req.params.commentId, req.params.id],
  );
  if (!existing) throw new NotFoundError('Comment not found');
  if (existing.user_id !== user.id && !user.isAdmin) {
    throw new ForbiddenError('Only the person who wrote this note can edit it');
  }

  // No history entry when nothing changed — a save is not always an edit.
  const changed = existing.body !== body;
  const history = changed
    ? [...(existing.edit_history ?? []), { body: existing.body, at: new Date().toISOString() }]
    : existing.edit_history ?? [];

  // jsonb arrives already parsed; mentions only falls back to a list when null.
  const before = new Set(Array.isArray(existing.mentions) ? existing.mentions as string[] : []);

  await db.query(
    `UPDATE ipy_comment
        SET body = $3, mentions = $4, edit_history = $5, updated_at = now()
      WHERE id = $1 AND record_id = $2`,
    [req.params.commentId, req.params.id, body, JSON.stringify(mentions ?? [...before]), JSON.stringify(history)],
  );

  // Newly @mentioned colleagues hear about it the same as on a fresh post;
  // anybody mentioned in the old text is not re-pinged.
  const fresh = (mentions ?? []).filter((m) => m !== user.id && !before.has(m));
  if (fresh.length) {
    await notifyMany(fresh, {
      kind: 'mention',
      title: `${user.fullName} mentioned you`,
      body: body.slice(0, 200),
      link: `/${req.params.module}/${req.params.id}`,
      recordId: req.params.id,
    });
  }

  await recordService.touchActivity(req.params.id);
  res.json({ ok: true, edited: changed });
}));

recordsRouter.delete('/:module/:id/comments/:commentId', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const result = await db.query(
    `DELETE FROM ipy_comment WHERE id = $1 AND record_id = $2 ${user.isAdmin ? '' : 'AND user_id = $3'}`,
    user.isAdmin ? [req.params.commentId, req.params.id] : [req.params.commentId, req.params.id, user.id],
  );
  if (!result.rowCount) throw new NotFoundError('Comment not found');
  res.json({ ok: true });
}));

/** Related list: records of `relation` hanging off this record. */
recordsRouter.get('/:module/:id/related/:relation', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const { module, id, relation: relationName } = req.params;
  if (!(await canAccessRecord(scope, module, id, 'view'))) throw new ForbiddenError();

  const relation = await registry.getRelation(module, relationName);
  if (!relation) throw new NotFoundError(`Unknown related list '${relationName}'`);

  const page = Number(req.query.page) || 1;
  const pageSize = Math.min(100, Number(req.query.pageSize) || 20);

  if (relation.type === 'one_to_many' && relation.foreignField) {
    const result = await recordService.listRecords(scope, relation.targetModule, {
      filter: { logic: 'AND', conditions: [{ field: relation.foreignField, operator: 'equals', value: id }] },
      page, pageSize,
      columns: relation.columns,
    });
    res.json({ ...result, relation });
    return;
  }

  // many_to_many via the generic link table
  const links = await db.query<{ target_id: string }>(
    `SELECT target_id FROM ipy_record_link WHERE relation_id = $1 AND source_id = $2`,
    [relation.id, id],
  );
  const ids = links.rows.map((l) => l.target_id);
  if (!ids.length) {
    res.json({ rows: [], page, pageSize, total: 0, totalPages: 1, relation });
    return;
  }
  const result = await recordService.listRecords(scope, relation.targetModule, {
    filter: { logic: 'AND', conditions: [{ field: 'id', operator: 'in', value: ids }] },
    page, pageSize,
  });
  res.json({ ...result, relation });
}));

/** Attach an existing record to a many-to-many related list. */
recordsRouter.post('/:module/:id/related/:relation', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const { module, id, relation: relationName } = req.params;
  if (!(await canAccessRecord(scope, module, id, 'edit'))) throw new ForbiddenError();
  const relation = await registry.getRelation(module, relationName);
  if (!relation) throw new NotFoundError(`Unknown related list '${relationName}'`);

  const { targetId } = z.object({ targetId: z.string().uuid() }).parse(req.body);

  if (relation.type === 'one_to_many' && relation.foreignField) {
    await recordService.updateRecord(scope, relation.targetModule, targetId, { [relation.foreignField]: id });
  } else {
    await db.query(
      `INSERT INTO ipy_record_link (relation_id, source_id, target_id, created_by)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [relation.id, id, targetId, getUser(req).id],
    );
  }
  res.json({ ok: true });
}));

recordsRouter.delete('/:module/:id/related/:relation/:targetId', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const { module, id, relation: relationName, targetId } = req.params;
  if (!(await canAccessRecord(scope, module, id, 'edit'))) throw new ForbiddenError();
  const relation = await registry.getRelation(module, relationName);
  if (!relation) throw new NotFoundError(`Unknown related list '${relationName}'`);

  if (relation.type === 'one_to_many' && relation.foreignField) {
    await recordService.updateRecord(scope, relation.targetModule, targetId, { [relation.foreignField]: null });
  } else {
    await db.query(`DELETE FROM ipy_record_link WHERE relation_id = $1 AND source_id = $2 AND target_id = $3`, [
      relation.id, id, targetId,
    ]);
  }
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
/**
 * Neighbours: the records immediately before and after this one in the list
 * the user came from.
 *
 * The arrows on the record header used to read a list of ids the list page
 * had stashed in sessionStorage — which goes stale the moment the record was
 * opened from anywhere else (search, a notification, a pasted URL, a page
 * refresh): no entry, both arrows dead. This answers the question properly,
 * from the same saved view and sort the back button restores.
 *
 * The cursor is the sort value of this record, with the record id breaking
 * ties, reusing the list engine's own filter/sort so permissions and hidden
 * fields apply identically.
 */
recordsRouter.get('/:module/:id/neighbours', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const { module: moduleName, id } = req.params;
  const viewId = typeof req.query.view === 'string' && req.query.view ? req.query.view : undefined;
  const sortParam = typeof req.query.sort === 'string' && req.query.sort ? req.query.sort : undefined;
  const dirParam = req.query.dir === 'asc' ? 'asc' as const : req.query.dir === 'desc' ? 'desc' as const : undefined;

  const current = await recordService.getRecord(scope, moduleName, id);
  const view = viewId
    ? await db.queryOne<{ filter: FilterGroup; sort_by: string | null; sort_dir: string }>(
      `SELECT filter, sort_by, sort_dir FROM ipy_view WHERE id = $1`, [viewId])
    : null;

  const field = sortParam ?? view?.sort_by ?? 'created_at';
  // The direction comes from ?dir, or the view's, or the list default. (The
  // sort FIELD and the direction are two different things; conflating them
  // once produced a cursor that never matched and neighbours from the wrong
  // end of the table.)
  const dir: 'asc' | 'desc' = dirParam ?? (view?.sort_dir === 'asc' ? 'asc' : 'desc');
  const value = (current.values as Record<string, unknown>)[field];

  // No comparable value (a blank sort field on this record): say so rather
  // than guess, and the UI keeps the arrows idle.
  if (value === null || value === undefined) {
    res.json({ prevId: null, nextId: null });
    return;
  }

  const atOrTie = (op: 'greater_than' | 'less_than'): FilterGroup => ({
    // A record with no value for the sort field has no position in the list;
    // the explicit not-empty guard keeps it out of both branches whatever the
    // comparison engine does with NULL.
    logic: 'AND',
    conditions: [
      { field, operator: 'is_not_empty' },
      /*
        A record is never its own neighbour. Said outright, because leaving it
        to the value comparison is what broke the back arrow.

        Postgres keeps timestamps to the microsecond and a JavaScript Date only
        to the millisecond, so a `created_at` of `04:34:17.534234` reaches this
        filter as `04:34:17.534`. On the default newest-first list "previous"
        asks for `created_at > .534000` — and `.534234` is greater, so every
        record matched itself and the arrow reloaded the page you were already
        on. "Next" asks for `< .534000`, which excludes it, which is why only
        one arrow appeared broken.

        The equality tiebreak below cannot save it either: the two values are
        not equal once one has been truncated. Excluding the id is exact,
        needs no precision at all, and is what the rule actually means.
      */
      { field: 'id', operator: 'not_equals', value: id },
      {
        logic: 'OR',
        conditions: [
          { field, operator: op, value },
          { logic: 'AND', conditions: [{ field, operator: 'equals', value }, { field: 'id', operator: op, value: id }] },
        ],
      },
    ],
  });

  const neighbour = async (which: 'prev' | 'next'): Promise<string | null> => {
    // "Next" walks the list in its own direction from the cursor; "prev"
    // walks the same list backwards, so both are one row fetches.
    const forward = which === 'next';
    const filter: FilterGroup = forward
      ? atOrTie(dir === 'asc' ? 'greater_than' : 'less_than')
      : atOrTie(dir === 'asc' ? 'less_than' : 'greater_than');
    const result = await recordService.listRecords(scope, moduleName, {
      ...(viewId ? { view: viewId } : {}),
      filter,
      sortBy: field,
      sortDir: forward ? dir : dir === 'asc' ? 'desc' : 'asc',
      page: 1,
      pageSize: 1,
    });
    if (process.env.NEIGHBOUR_DEBUG) console.log("NB", which, JSON.stringify(filter), "row budget:", result.rows[0]?.values?.budget ?? null, result.rows[0]?.id ?? null);
    return result.rows[0]?.id ?? null;
  };

  // The header counter must describe the whole filtered result, not the 25
  // ids that the browser happened to have rendered on the list page.
  const all = await recordService.listRecords(scope, moduleName, {
    ...(viewId ? { view: viewId } : {}),
    page: 1,
    pageSize: 1,
    sortBy: field,
    sortDir: dir,
  });
  const before = await recordService.listRecords(scope, moduleName, {
    ...(viewId ? { view: viewId } : {}),
    filter: atOrTie(dir === 'asc' ? 'less_than' : 'greater_than'),
    page: 1,
    pageSize: 1,
    sortBy: field,
    sortDir: dir,
  });
  res.json({
    prevId: await neighbour('prev'),
    nextId: await neighbour('next'),
    position: before.total + 1,
    total: all.total,
  });
}));

// Tags, stars, sharing
// ---------------------------------------------------------------------------

recordsRouter.post('/:module/:id/tags', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const { tags } = z.object({ tags: z.array(z.string().min(1).max(40)) }).parse(req.body);
  if (!(await canAccessRecord(scope, req.params.module, req.params.id, 'edit'))) throw new ForbiddenError();

  await transaction(async (tx) => {
    await tx.query(`DELETE FROM ipy_tag_link WHERE record_id = $1`, [req.params.id]);
    for (const name of tags) {
      const tag = await tx.queryOne<{ id: string }>(
        `INSERT INTO ipy_tag (name, created_by) VALUES ($1,$2)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [name.trim().toLowerCase(), getUser(req).id],
      );
      if (tag) {
        await tx.query(`INSERT INTO ipy_tag_link (tag_id, record_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [
          tag.id, req.params.id,
        ]);
      }
    }
  });
  res.json({ ok: true, tags });
}));

recordsRouter.post('/:module/:id/star', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const user = getUser(req);
  if (!(await canAccessRecord(scope, req.params.module, req.params.id, 'view'))) {
    throw new ForbiddenError('You cannot favourite this record');
  }
  const record = await db.queryOne<{ module_name: string }>(
    `SELECT module_name FROM ipy_record WHERE id = $1 AND is_deleted = false`,
    [req.params.id],
  );
  if (!record || record.module_name !== req.params.module) throw new NotFoundError('Record not found');
  const starred = req.body?.starred !== false;
  if (starred) {
    await db.query(`INSERT INTO ipy_starred (user_id, record_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [user.id, req.params.id]);
  } else {
    await db.query(`DELETE FROM ipy_starred WHERE user_id = $1 AND record_id = $2`, [user.id, req.params.id]);
  }
  res.json({ ok: true, starred });
}));

recordsRouter.post('/:module/:id/share', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const user = getUser(req);
  if (!(await canAccessRecord(scope, req.params.module, req.params.id, 'edit'))) throw new ForbiddenError();

  const { subjects } = z.object({
    subjects: z.array(z.object({
      type: z.enum(['user', 'group', 'role']),
      id: z.string().uuid(),
      access: z.enum(['read', 'read_write']).default('read'),
    })),
  }).parse(req.body);

  await transaction(async (tx) => {
    await tx.query(`DELETE FROM ipy_record_share WHERE record_id = $1`, [req.params.id]);
    for (const s of subjects) {
      await tx.query(
        `INSERT INTO ipy_record_share (record_id, subject_type, subject_id, access, shared_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [req.params.id, s.type, s.id, s.access, user.id],
      );
    }
  });
  res.json({ ok: true });
}));

/**
 * Who a record has been shared with.
 *
 * The access check was simply missing. Every neighbouring route has one — the
 * record itself, its timeline, its comments, its audit trail and its share
 * links all answer 403 to somebody outside the record's scope — and this one
 * answered 200 to anybody signed in.
 *
 * What that gave away is narrow but real: that a record with this id exists,
 * and the names of the people and teams it has been shared with. On a CRM where
 * leads are private by default, that is the sharing graph of somebody else's
 * pipeline.
 */
recordsRouter.get('/:module/:id/shares', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  if (!(await canAccessRecord(scope, req.params.module, req.params.id, 'view'))) throw new ForbiddenError();
  const rows = await db.query(
    `SELECT subject_type, subject_id, access, created_at FROM ipy_record_share WHERE record_id = $1`,
    [req.params.id],
  );
  res.json(rows.rows);
}));

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

recordsRouter.get('/:module/:id/audit', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  if (!(await canAccessRecord(scope, req.params.module, req.params.id, 'view'))) throw new ForbiddenError();
  const rows = await db.query(
    `SELECT a.id, a.action, a.changes, a.source, a.created_at, a.user_id,
            trim(u.first_name || ' ' || u.last_name) AS user_name
     FROM ipy_audit a LEFT JOIN ipy_user u ON u.id = a.user_id
     WHERE a.record_id = $1 ORDER BY a.created_at DESC LIMIT 100`,
    [req.params.id],
  );
  res.json(rows.rows);
}));

// ---------------------------------------------------------------------------
// Field permissions for the form renderer
// ---------------------------------------------------------------------------

recordsRouter.get('/:module/meta/field-permissions', asyncHandler(async (req, res) => {
  const perms = await getFieldPermissions(getUser(req), req.params.module);
  res.json(Object.fromEntries(perms));
}));

// ---------------------------------------------------------------------------
// Share links — see core/sharing/shareLinks.ts.
//
// Named `share-links`, not `shares`: `POST /:module/:id/share` and
// `GET /:module/:id/shares` already exist and mean something entirely
// different — granting another *user* access to the record. Express matches
// the first route registered, so reusing that path silently shadowed these
// behind the internal ones. Caught by a test that got an empty list back.
//
// Making one requires 'view' on the record, not 'edit': a link exposes exactly
// what its maker could already see, and adds nothing to the record. Requiring
// edit would stop a telecaller sending a buyer a property they are allowed to
// discuss, which is the whole job.
// ---------------------------------------------------------------------------

recordsRouter.get('/:module/:id/share-links', asyncHandler(async (req, res) => {
  const { module, id } = req.params;
  if (!(await canAccessRecord(getScope(req), module, id, 'view'))) throw new ForbiddenError();
  res.json(await listShareLinks(id));
}));

recordsRouter.post('/:module/:id/share-links', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const user = getUser(req);
  const { module, id } = req.params;
  if (!(await canAccessRecord(scope, module, id, 'view'))) throw new ForbiddenError();

  const { label, expiresInDays } = z.object({
    /** Who it is going to. The sender's own note — never shown to the visitor. */
    label: z.string().max(120).optional(),
    /** Omitted means it never expires, which is the default on purpose. */
    expiresInDays: z.number().int().min(1).max(365).optional(),
  }).parse(req.body ?? {});

  const link = await createShareLink({
    recordId: id,
    userId: user.id,
    label: label ?? null,
    expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000) : null,
  });

  res.status(201).json(link);
}));

// ---------------------------------------------------------------------------
// A saved matching, and a link to the picked rows.
//
// Both hang off the record whose matching tab they came from, and both need
// only 'view' on it — for the same reason the share links above do: neither
// changes the record, and a telecaller who may discuss a unit may send it.
// ---------------------------------------------------------------------------

/** The pinned matching for this record, or null if it is running live. */
recordsRouter.get('/:module/:id/matches/snapshot', asyncHandler(async (req, res) => {
  const { module, id } = req.params;
  if (!(await canAccessRecord(getScope(req), module, id, 'view'))) throw new ForbiddenError();

  const row = await db.queryOne<{
    entries: unknown; filters: unknown; saved_at: Date; saved_by: string | null; saved_by_name: string | null;
  }>(
    `SELECT s.entries, s.filters, s.saved_at, s.saved_by,
            NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS saved_by_name
       FROM ipy_match_snapshot s
       LEFT JOIN ipy_user u ON u.id = s.saved_by
      WHERE s.record_id = $1 AND s.module = $2`,
    [id, module],
  );
  if (!row) { res.json(null); return; }
  res.json({
    entries: row.entries,
    filters: row.filters,
    savedAt: row.saved_at,
    savedById: row.saved_by,
    savedByName: row.saved_by_name ?? 'somebody since removed',
  });
}));

/** Pin this matching exactly as it stands. */
recordsRouter.put('/:module/:id/matches/snapshot', asyncHandler(async (req, res) => {
  const { module, id } = req.params;
  const user = getUser(req);
  if (!(await canAccessRecord(getScope(req), module, id, 'view'))) throw new ForbiddenError();

  const input = z.object({
    entries: z.array(z.object({
      targetId: z.string().uuid(),
      score: z.number(),
      matchedFields: z.array(z.string()).optional(),
    })).max(500),
    filters: z.array(z.string()).max(50).default([]),
  }).parse(req.body ?? {});

  await db.query(
    `INSERT INTO ipy_match_snapshot (record_id, module, entries, filters, saved_by, saved_at)
     VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (record_id, module)
     DO UPDATE SET entries = EXCLUDED.entries, filters = EXCLUDED.filters,
                   saved_by = EXCLUDED.saved_by, saved_at = now()`,
    [id, module, JSON.stringify(input.entries), JSON.stringify(input.filters), user.id],
  );
  res.json({ ok: true });
}));

/** Unpin it — the engine's answer comes back. */
recordsRouter.delete('/:module/:id/matches/snapshot', asyncHandler(async (req, res) => {
  const { module, id } = req.params;
  if (!(await canAccessRecord(getScope(req), module, id, 'view'))) throw new ForbiddenError();
  await db.query(`DELETE FROM ipy_match_snapshot WHERE record_id = $1 AND module = $2`, [id, module]);
  res.json({ ok: true });
}));

/**
 * A public link to the matches somebody ticked.
 *
 * Every id is checked against what the caller may see before it goes on the
 * link. Without that, a rep could put any record id in the body and mint a
 * public page for a unit their role hides from them — the sort of hole that
 * only ever shows up after the link has been forwarded.
 */
recordsRouter.post('/:module/:id/matches/share', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const user = getUser(req);
  const { module, id } = req.params;
  if (!(await canAccessRecord(scope, module, id, 'view'))) throw new ForbiddenError();

  const input = z.object({
    targetModule: z.string().min(1).max(60),
    ids: z.array(z.string().uuid()).min(1).max(50),
    label: z.string().max(120).optional(),
    expiresInDays: z.number().int().min(1).max(365).optional(),
  }).parse(req.body ?? {});

  await registry.requireModule(input.targetModule);

  const allowed: string[] = [];
  for (const targetId of input.ids) {
    if (await canAccessRecord(scope, input.targetModule, targetId, 'view')) allowed.push(targetId);
  }
  if (!allowed.length) throw new ForbiddenError('None of those records are yours to share');

  const link = await createShareLink({
    recordId: id,
    userId: user.id,
    label: input.label ?? null,
    expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
    kind: 'matches',
    payload: { targetModule: input.targetModule, ids: allowed },
  });

  /* The token, not a URL. `APP_URL` holds every origin this CRM answers on —
     it is a comma-separated list, and the browser already knows which one the
     person is standing on. The web builds the link, exactly as it does for a
     one-property share link.

     `withheld` is said out loud rather than silently dropped: a rep who ticked
     eight and gets a link showing six needs to know. */
  res.status(201).json({
    ...link,
    shared: allowed.length,
    withheld: input.ids.length - allowed.length,
  });
}));

recordsRouter.delete('/:module/:id/share-links/:linkId', asyncHandler(async (req, res) => {
  const { module, id, linkId } = req.params;
  if (!(await canAccessRecord(getScope(req), module, id, 'view'))) throw new ForbiddenError();

  // Scoped to this record inside the query too, so a guessed link id belonging
  // to a property the caller cannot see is not revocable from here.
  const revoked = await revokeShareLink(linkId, id);
  if (!revoked) throw new NotFoundError('Link not found');
  res.status(204).end();
}));

/**
 * "The originals are in the folder — go and process them."
 *
 * The whole handoff, and deliberately the only thing the CRM does about media
 * after making the folder. Everything slow happens in n8n, inside OneDrive:
 * renaming the originals, the compressed copies, the watermarked set, the
 * social and website folders.
 *
 * Answers 202 whether or not n8n took it, with a reason attached. A rep who has
 * finished uploading has finished, and the CRM refusing that because an
 * automation server is down would be the CRM inventing a problem it does not
 * have. Pressing Finish again re-sends it, which is the retry.
 */
recordsRouter.post('/properties/:id/finish', asyncHandler(async (req, res) => {
  const user = getUser(req);
  // Finishing a unit kicks off the media handoff, which is a change to the
  // record's world — gated like one, not left open to any signed-in user who
  // can name a UUID.
  if (!(await canAccessRecord(req.scope!, 'properties', req.params.id, 'edit'))) throw new ForbiddenError();
  // Record it first, always. The webhook below only lands when the CRM can
  // reach n8n, which in production it cannot — n8n collects this row instead.
  await db.query(
    `UPDATE ipy_property_storage SET media_requested_at = now(), updated_at = now()
      WHERE record_id = $1`,
    [req.params.id],
  );

  const { notifyPropertyFinished } = await import('../../integrations/automation/n8n.js');
  const pushed = await notifyPropertyFinished(req.params.id);
  // Queued is the honest answer either way: the request is durable now, so a
  // webhook that could not be delivered is a timing detail, not a failure.
  const result = pushed.sent
    ? pushed
    : { sent: true, reason: `queued for the automation server (${pushed.reason})` };

  logger.info(
    { recordId: req.params.id, userId: user.id, sent: result.sent, reason: result.reason },
    'property finished',
  );
  res.status(202).json(result);
}));

/**
 * The real phone number for one record, when the team only sees `98xxxxxx56`.
 *
 * One record, one field, one audit row. That is the whole design: ringing a
 * customer is ordinary and leaves a trace nobody minds; building a list means
 * hundreds of traces with a name on them.
 *
 * Permission-checked like any other read of the record, so this is not a way
 * around who can see what — only around the masking.
 */
recordsRouter.get('/:module/:id/phone/:field', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const { module, id, field } = req.params;

  if (!(await canAccessRecord(req.scope!, module, id, 'view'))) throw new ForbiddenError();

  const { revealPhone } = await import('../../core/permissions/maskPhones.js');
  const number = await revealPhone(user, module, id, field);
  if (number === null) throw new NotFoundError('No number on that field');
  res.json({ number });
}));

/** Where this property's originals live, so the CRM can link straight to it. */
recordsRouter.get('/properties/:id/storage', asyncHandler(async (req, res) => {
  // The folder location is a fact about the record, read like one.
  if (!(await canAccessRecord(req.scope!, 'properties', req.params.id, 'view'))) throw new ForbiddenError();
  const { getPropertyStorageStatus } = await import('../../core/storage/propertyFolders.js');
  res.json(await getPropertyStorageStatus(req.params.id));
}));
