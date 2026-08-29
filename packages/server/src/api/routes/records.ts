import { Router } from 'express';
import { logger } from '../../utils/logger.js';
import { z } from 'zod';
import { createShareLink, listShareLinks, revokeShareLink } from '../../core/sharing/shareLinks.js';
import type { FilterGroup } from '@ipropy/shared';
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
  const { ids, values } = z.object({
    ids: z.array(z.string().uuid()).min(1).max(500),
    values: z.record(z.unknown()),
  }).parse(req.body);
  res.json(await recordService.massUpdate(getScope(req), req.params.module, ids, values));
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
            trim(u.first_name || ' ' || u.last_name) AS user_name, u.avatar_url AS user_avatar
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

recordsRouter.get('/:module/:id/shares', asyncHandler(async (req, res) => {
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
  const { getPropertyStorageStatus } = await import('../../core/storage/propertyFolders.js');
  res.json(await getPropertyStorageStatus(req.params.id));
}));
