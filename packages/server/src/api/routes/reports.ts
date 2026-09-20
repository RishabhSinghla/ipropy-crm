/**
 * Saved questions, answered when somebody asks them.
 *
 * A report here is a **saved `WidgetConfig`** — the same shape a dashboard tile
 * holds, run by the same engine (`core/analytics/widgets.ts`) against the same
 * permission-scoped SQL every list uses. That is the whole design: this CRM
 * already knows how to group contacts by source and total a number under the
 * asker's own visibility, and a second engine for reporting would drift from
 * the first the day a field is deleted.
 *
 * Two rules the shape encodes:
 *
 *  * **Nothing is cached.** The report stores the question; running it is a
 *    live query as the person asking. A shared report opened by a manager and
 *    by a rep is the same question over two different sets of records, which is
 *    what "shared" has to mean in a CRM with a role hierarchy. A stored total
 *    would be one number for everybody — a permissions leak wearing a chart.
 *  * **Sharing is the same decision as sharing a dashboard**, so it is the same
 *    capability (`dashboards.share`). A new capability would be held by nobody
 *    until an admin ticked it on every profile, which on the day it shipped
 *    would read as the feature being broken.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { WidgetConfig } from '@ipropy/shared';
import { db } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { getScope, getUser, requireAuth } from '../../middleware/auth.js';
import { ForbiddenError, NotFoundError } from '../../utils/errors.js';
import { hasCapability } from '../../core/permissions/index.js';
import { runWidget } from '../../core/analytics/widgets.js';
import { registry } from '../../core/metadata/registry.js';

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

interface ReportRow {
  id: string; name: string; description: string | null; module_name: string;
  type: string; config: WidgetConfig; owner_id: string | null; is_shared: boolean;
  created_at: string; updated_at: string;
}

const shape = (row: ReportRow, userId: string): Record<string, unknown> => ({
  id: row.id,
  name: row.name,
  description: row.description,
  module: row.module_name,
  type: row.type,
  config: row.config,
  ownerId: row.owner_id,
  isShared: row.is_shared,
  isMine: row.owner_id === userId,
  updatedAt: row.updated_at,
});

const reportInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).nullish(),
  module: z.string().min(1).max(60),
  type: z.string().min(1).max(40),
  config: z.record(z.unknown()),
  isShared: z.boolean().optional(),
});

/** Yours and the team's, newest first within each. */
reportsRouter.get('/', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const rows = await db.query<ReportRow>(
    `SELECT * FROM ipy_report
      WHERE is_shared OR owner_id = $1
      ORDER BY is_shared, name`,
    [user.id],
  );
  res.json(rows.rows.map((row) => shape(row, user.id)));
}));

/**
 * Run a question — saved or not.
 *
 * The builder posts an unsaved config here for its preview, and the saved list
 * posts the stored one. One path, so what somebody sees while building is what
 * they get after saving; a separate preview endpoint is how those two come to
 * disagree.
 */
reportsRouter.post('/run', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const { type, config } = z.object({
    type: z.string().min(1).max(40),
    config: z.record(z.unknown()),
  }).parse(req.body ?? {});
  res.json(await runWidget(scope, type, config as WidgetConfig));
}));

/**
 * The same answer as a spreadsheet.
 *
 * Deliberately the *report's* rows and not the records behind them: a report is
 * a summary, and "contacts by source" exports as five lines. Exporting the
 * underlying records is what the list's own export is for, and it is gated on
 * `records.export` for a reason — this one is not a way around it, because a
 * count of records is not the records.
 */
reportsRouter.post('/export', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const { type, config, title } = z.object({
    type: z.string().min(1).max(40),
    config: z.record(z.unknown()),
    title: z.string().max(120).optional(),
  }).parse(req.body ?? {});

  const result = await runWidget(scope, type, config as WidgetConfig);
  const cell = (value: unknown): string => {
    const text = value === null || value === undefined ? '' : String(value);
    // A leading =, +, - or @ is a formula to a spreadsheet, so a value typed by
    // a customer could run when somebody opens the file. Prefixed, not stripped:
    // the value is still readable and no longer executable.
    const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };

  const lines: string[] = [];
  if (result.series?.length) {
    lines.push(['Group', 'Value'].map(cell).join(','));
    for (const point of result.series) lines.push([point.label, point.value].map(cell).join(','));
  } else if (result.stages?.length) {
    lines.push(['Stage', 'Value', 'From previous %', 'From first %'].map(cell).join(','));
    for (const stage of result.stages) {
      lines.push([stage.label, stage.value, stage.conversionFromPrevious, stage.conversionFromFirst].map(cell).join(','));
    }
  } else if (result.rows?.length) {
    const columns = result.columns?.length ? result.columns : Object.keys(result.rows[0]);
    lines.push(columns.map(cell).join(','));
    for (const row of result.rows) lines.push(columns.map((column) => cell(row[column])).join(','));
  } else {
    lines.push(['Value'].map(cell).join(','));
    lines.push(cell(result.value ?? 0));
  }

  const name = (title ?? 'report').replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'report';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
  // The BOM is what makes Excel read this as UTF-8; without it a name in
  // Devanagari opens as mojibake and the file looks corrupted.
  res.send(`﻿${lines.join('\n')}`);
}));

reportsRouter.post('/', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const input = reportInput.parse(req.body ?? {});
  await registry.requireModule(input.module);
  const shared = input.isShared === true && await hasCapability(user, 'dashboards.share');

  const row = await db.queryOne<ReportRow>(
    `INSERT INTO ipy_report (name, description, module_name, type, config, owner_id, is_shared)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING *`,
    [input.name, input.description ?? null, input.module, input.type,
      JSON.stringify(input.config), user.id, shared],
  );
  res.status(201).json(shape(row!, user.id));
}));

/** Yours to change, or anyone's if you administer the CRM. */
async function assertCanEdit(id: string, userId: string, isAdmin: boolean): Promise<ReportRow> {
  const row = await db.queryOne<ReportRow>(`SELECT * FROM ipy_report WHERE id = $1`, [id]);
  if (!row) throw new NotFoundError('That report no longer exists.');
  if (row.owner_id !== userId && !isAdmin) {
    throw new ForbiddenError('You can only change reports you created.');
  }
  return row;
}

reportsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCanEdit(req.params.id, user.id, user.isAdmin);
  const input = reportInput.partial().parse(req.body ?? {});
  if (input.module) await registry.requireModule(input.module);
  const shared = input.isShared === undefined
    ? null
    : input.isShared && await hasCapability(user, 'dashboards.share');

  const row = await db.queryOne<ReportRow>(
    `UPDATE ipy_report
        SET name = COALESCE($2, name),
            description = COALESCE($3, description),
            module_name = COALESCE($4, module_name),
            type = COALESCE($5, type),
            config = COALESCE($6::jsonb, config),
            is_shared = COALESCE($7, is_shared),
            updated_at = now()
      WHERE id = $1 RETURNING *`,
    [req.params.id, input.name ?? null, input.description ?? null, input.module ?? null,
      input.type ?? null, input.config ? JSON.stringify(input.config) : null, shared],
  );
  res.json(shape(row!, user.id));
}));

reportsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCanEdit(req.params.id, user.id, user.isAdmin);
  await db.query(`DELETE FROM ipy_report WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));
