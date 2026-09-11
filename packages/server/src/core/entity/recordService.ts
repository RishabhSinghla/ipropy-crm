/**
 * The generic record engine.
 *
 * Every module — seeded or admin-created — is read and written through here.
 * There is no per-module CRUD code anywhere in the app; behaviour differences
 * come entirely from metadata plus the hook points at the bottom of this file.
 */
import {
  UITYPES,
  formatArea,
  formatIndianPrice,
  formatPhoneWithCode,
  isFilterGroup,
  type FieldMeta,
  type FilterCondition,
  type FilterGroup,
  type ListQuery,
  type ListResult,
  type ModuleMeta,
  type RecordEnvelope,
} from '@ipropy/shared';
import { db, onCommit, transaction, type Tx } from '../../db/pool.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { emit } from '../events/bus.js';
import { registry } from '../metadata/registry.js';
import {
  coerceValue, formatValue, fromDbValue, isEmpty, toDbValue, validateRequired, validateValues,
} from '../metadata/values.js';
import {
  ENTITY_ALIAS,
  RECORD_ALIAS,
  SqlParams,
  buildOrderBy,
  buildSearchClause,
  buildWhere,
  fieldExpr,
  quoteIdent,
  resolveFieldPath,
  type BuildContext,
} from '../query/builder.js';
import { evaluateFormula } from './formula.js';
import { nextNumber } from './numbering.js';
import { computeRollups } from './rollups.js';
import {
  assertModuleAccess,
  assertRecordAccess,
  filterWritableFields,
  getFieldPermissions,
  recordScopeSql,
  type ScopeContext,
} from '../permissions/index.js';
import { maskNumber, maskedPhoneFields } from '../permissions/maskPhones.js';

export interface ServiceContext extends ScopeContext {
  source?: string;
  /** skip permission checks — used by the workflow engine and integrations */
  system?: boolean;
}

export interface SaveOptions {
  skipWorkflow?: boolean;
  skipDuplicateCheck?: boolean;
  skipAudit?: boolean;
  conn?: Tx;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getRecord(
  ctx: ServiceContext,
  moduleName: string,
  recordId: string,
  opts: { conn?: Tx; withDisplay?: boolean } = {},
): Promise<RecordEnvelope> {
  const conn = opts.conn ?? db;
  const module = await registry.requireModule(moduleName);
  if (!ctx.system) {
    await assertModuleAccess(ctx.user, moduleName, 'view');
    await assertRecordAccess(ctx, moduleName, recordId, 'view', conn);
  }

  const row = await conn.queryOne<Record<string, unknown>>(
    `SELECT ${RECORD_ALIAS}.*, ${ENTITY_ALIAS}.*
     FROM ipy_record ${RECORD_ALIAS}
     JOIN ${quoteIdent(module.tableName)} ${ENTITY_ALIAS} ON ${ENTITY_ALIAS}.record_id = ${RECORD_ALIAS}.id
     WHERE ${RECORD_ALIAS}.id = $1 AND ${RECORD_ALIAS}.is_deleted = false`,
    [recordId],
  );
  if (!row) throw new NotFoundError(`${module.singularLabel} not found`);

  const rollups = await computeRollups(conn, module, [recordId], buildContextFrom(ctx));
  const envelope = await rowToEnvelope(module, row, {
    withDisplay: opts.withDisplay !== false,
    conn,
    rollups: rollups.get(recordId),
  });
  if (!ctx.system) {
    stripHidden(envelope, await hiddenFieldsFor(ctx, moduleName));
    maskPhones(envelope, await maskedPhoneFields(ctx.user, moduleName, envelope.ownerId));
  }
  return envelope;
}

function buildContextFrom(ctx: ServiceContext): BuildContext {
  return {
    userId: ctx.user.id,
    groupIds: ctx.groupIds,
    subordinateIds: ctx.subordinateIds,
    timezone: ctx.user.timezone,
  };
}

/**
 * Field-level read enforcement.
 *
 * Profile permissions hide fields in the metadata so the UI never renders them,
 * but the API must strip the values too — otherwise the data is one raw request
 * away from anyone who can read the module.
 */
async function hiddenFieldsFor(ctx: ServiceContext, moduleName: string): Promise<Set<string>> {
  if (ctx.user.isAdmin) return new Set();
  const perms = await getFieldPermissions(ctx.user, moduleName);
  const hidden = new Set<string>();
  for (const [name, permission] of perms) {
    if (permission === 'hidden') hidden.add(name);
  }
  return hidden;
}

/**
 * Every field name a filter tree mentions, however deeply nested.
 *
 * Walks groups as well as conditions: an injection oracle hidden three levels
 * down inside an OR is still an oracle, and a guard that only reads the top
 * level would wave it through.
 */
function filterFieldNames(filter: FilterGroup | undefined): string[] {
  if (!filter) return [];
  const names: string[] = [];
  const walk = (node: FilterCondition | FilterGroup): void => {
    if (isFilterGroup(node)) {
      for (const child of node.conditions ?? []) walk(child);
      return;
    }
    if (node?.field) names.push(node.field);
  };
  walk(filter);
  return names;
}

/**
 * Replace phone numbers with `98xxxxxx56` for somebody who may not see them.
 *
 * Applied here, beside `stripHidden`, because this is the one place every read
 * of a record's values passes through. Doing it in React would leave the real
 * number in the response, one devtools tab away from the person it is hidden
 * from. See core/permissions/maskPhones.ts, and the reveal endpoint that keeps
 * the phone usable.
 */
function maskPhones(envelope: RecordEnvelope, masked: Set<string>): void {
  if (!masked.size) return;
  for (const name of masked) {
    if (name in envelope.values) envelope.values[name] = maskNumber(envelope.values[name]);
    if (envelope.display && name in envelope.display) {
      envelope.display[name] = maskNumber(envelope.display[name]) as string;
    }
  }
}

function stripHidden(envelope: RecordEnvelope, hidden: Set<string>): void {
  if (!hidden.size) return;
  for (const name of hidden) {
    delete envelope.values[name];
    if (envelope.display) {
      delete envelope.display[name];
      delete envelope.display[`${name}__module`];
    }
  }
}

export async function listRecords(
  ctx: ServiceContext,
  moduleName: string,
  q: ListQuery = {},
  opts: { conn?: Tx } = {},
): Promise<ListResult> {
  const conn = opts.conn ?? db;
  const module = await registry.requireModule(moduleName);
  if (!ctx.system) await assertModuleAccess(ctx.user, moduleName, 'view');

  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, q.pageSize ?? 25));
  const params = new SqlParams();
  const buildCtx = buildContextFrom(ctx);

  const clauses: string[] = [
    `${RECORD_ALIAS}.module_id = ${params.add(module.id)}::uuid`,
    q.includeDeleted ? '' : `${RECORD_ALIAS}.is_deleted = false`,
  ].filter(Boolean);

  const joinMap = new Map<string, string>();

  // saved view filter merges with the ad-hoc filter
  let effectiveFilter = q.filter;
  let effectiveSortBy = q.sortBy;
  let effectiveSortDir = q.sortDir ?? 'desc';
  let effectiveColumns = q.columns;
  if (q.view) {
    const view = await loadView(
      conn,
      module.id,
      q.view,
      ctx.user.id,
      Boolean(ctx.system || ctx.user.isAdmin),
    );
    if (!view) throw new NotFoundError('Saved view not found or not available');
    effectiveFilter = mergeFilters(view.filter, q.filter);
    if (!effectiveSortBy && view.sort_by) {
      effectiveSortBy = view.sort_by;
      effectiveSortDir = (view.sort_dir as 'asc' | 'desc') ?? 'desc';
    }
    if (!effectiveColumns?.length && Array.isArray(view.columns) && view.columns.length) {
      effectiveColumns = view.columns;
    }
  }

  // Field availability is enforced by the data service as well as the list
  // screen. A direct API call or an old saved view must not bypass an
  // administrator's "Allow sorting" switch.
  if (effectiveSortBy) {
    const sortField = module.fields.find((field) => field.name === effectiveSortBy);
    if (sortField?.config.sortable === false) effectiveSortBy = undefined;
  }

  // A field this profile cannot see must not be usable to *ask questions about*
  // either. Stripping the value from the response but still honouring
  // `budget > 5000000` leaves a binary-search oracle: a dozen requests
  // recover the exact number the permission was meant to withhold, and sorting
  // or grouping by it gives away the ordering for nothing. Checked here, before
  // any SQL is built, so filter, saved-view filter, sort and group-by are all
  // covered by the one guard.
  if (!ctx.system) {
    const hidden = await hiddenFieldsFor(ctx, moduleName);
    if (hidden.size) {
      const used = [
        ...filterFieldNames(effectiveFilter),
        ...(q.sortBy ? [q.sortBy] : []),
        ...(q.groupBy ? [q.groupBy] : []),
      ];
      const blocked = [...new Set(used)].filter((name) => hidden.has(String(name).split('.')[0] ?? ''));
      if (blocked.length) {
        throw new ForbiddenError(
          `You do not have access to ${blocked.length > 1 ? 'these fields' : 'this field'}: ${blocked.join(', ')}`,
        );
      }
    }
  }

  if (effectiveFilter) {
    const where = await buildWhere(module, effectiveFilter, params, buildCtx);
    if (where.sql) clauses.push(where.sql);
    for (const j of where.joins) joinMap.set(j, j);
  }

  if (q.search?.trim()) {
    clauses.push(buildSearchClause(q.search, params));
  }

  if (!ctx.system) {
    const scope = await recordScopeSql(ctx, moduleName, params);
    if (scope) clauses.push(scope);
  }

  const joinSql = [...joinMap.values()].join('\n');
  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const from = `
    FROM ipy_record ${RECORD_ALIAS}
    JOIN ${quoteIdent(module.tableName)} ${ENTITY_ALIAS} ON ${ENTITY_ALIAS}.record_id = ${RECORD_ALIAS}.id
    ${joinSql}
    ${whereSql}
  `;

  const countRes = await conn.queryOne<{ count: number }>(`SELECT COUNT(*)::int AS count ${from}`, params.all());
  const total = countRes?.count ?? 0;

  const orderBy = await buildOrderBy(module, effectiveSortBy, effectiveSortDir, joinMap);
  const limitParam = params.add(pageSize);
  const offsetParam = params.add((page - 1) * pageSize);

  const rowsRes = await conn.query<Record<string, unknown>>(
    `SELECT ${RECORD_ALIAS}.*, ${ENTITY_ALIAS}.*
     ${from}
     ORDER BY ${orderBy}
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params.all(),
  );

  const rollups = await computeRollups(conn, module, rowsRes.rows.map((r) => String(r.id)), buildCtx);
  const rows = await Promise.all(
    rowsRes.rows.map((r) => rowToEnvelope(module, r, {
      withDisplay: true,
      conn,
      rollups: rollups.get(String(r.id)),
    })),
  );

  // Favourite state belongs to the signed-in user, not the record. Resolve it
  // once for the page so every list/card/kanban renderer can keep the gold
  // highlight without issuing one query per row.
  if (!ctx.system && rows.length) {
    const starred = await conn.query<{ record_id: string }>(
      `SELECT record_id FROM ipy_starred
       WHERE user_id = $1 AND record_id = ANY($2::uuid[])`,
      [ctx.user.id, rows.map((row) => row.id)],
    );
    const starredIds = new Set(starred.rows.map((row) => row.record_id));
    for (const row of rows) row.starred = starredIds.has(row.id);
  }

  // Resolved once for the whole page rather than per row. A list view is the
  // easiest place to copy a thousand numbers from, so masking matters most here.
  if (!ctx.system) {
    const hidden = await hiddenFieldsFor(ctx, moduleName);
    // Resolved once for the whole page — the answer depends on the profile,
    // which does not change between rows — and then applied per row against
    // that row's owner, because `owner_only` does.
    const masked = await maskedPhoneFields(ctx.user, moduleName, null);
    for (const row of rows) {
      stripHidden(row, hidden);
      if (row.ownerId !== ctx.user.id) maskPhones(row, masked);
    }
  }

  const result: ListResult = {
    rows,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    columns: effectiveColumns,
  };

  if (q.groupBy) {
    result.groups = await computeGroups(conn, module, q.groupBy, effectiveFilter, ctx, buildCtx);
  }

  return result;
}

/** Kanban column counts/sums for a grouping field. */
async function computeGroups(
  conn: Tx,
  module: ModuleMeta,
  groupBy: string,
  filter: FilterGroup | undefined,
  ctx: ServiceContext,
  buildCtx: BuildContext,
): Promise<ListResult['groups']> {
  const params = new SqlParams();
  const joinMap = new Map<string, string>();
  const resolved = await resolveFieldPath(module, groupBy, joinMap);

  const clauses = [
    `${RECORD_ALIAS}.module_id = ${params.add(module.id)}::uuid`,
    `${RECORD_ALIAS}.is_deleted = false`,
  ];
  if (filter) {
    const where = await buildWhere(module, filter, params, buildCtx);
    if (where.sql) clauses.push(where.sql);
    for (const j of where.joins) joinMap.set(j, j);
  }
  if (!ctx.system) {
    const scope = await recordScopeSql(ctx, module.name, params);
    if (scope) clauses.push(scope);
  }

  // Sum the module's headline amount field when one exists (deal value, price).
  const amountField = module.fields.find((f) => f.uitype === 'currency' && f.isActive);
  const sumExpr = amountField ? `COALESCE(SUM(${fieldExpr(amountField)}),0)` : 'NULL';

  const res = await conn.query<{ key: string | null; count: number; sum: number | null }>(
    `SELECT ${resolved.expr}::text AS key, COUNT(*)::int AS count, ${sumExpr} AS sum
     FROM ipy_record ${RECORD_ALIAS}
     JOIN ${quoteIdent(module.tableName)} ${ENTITY_ALIAS} ON ${ENTITY_ALIAS}.record_id = ${RECORD_ALIAS}.id
     ${[...joinMap.values()].join('\n')}
     WHERE ${clauses.join(' AND ')}
     GROUP BY 1`,
    params.all(),
  );

  const field = resolved.field;
  const options = field?.options ?? [];
  const byKey = new Map(res.rows.map((r) => [r.key ?? '', r]));

  // Preserve picklist order and include empty columns so the kanban is stable.
  if (options.length) {
    return options.map((o) => ({
      key: o.value,
      label: o.label,
      color: o.color,
      count: byKey.get(o.value)?.count ?? 0,
      sum: byKey.get(o.value)?.sum ?? 0,
    }));
  }
  return res.rows.map((r) => ({
    key: r.key ?? '',
    label: r.key ?? '(empty)',
    count: r.count,
    sum: r.sum ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Row → envelope
// ---------------------------------------------------------------------------

async function rowToEnvelope(
  module: ModuleMeta,
  row: Record<string, unknown>,
  opts: { withDisplay: boolean; conn: Tx; rollups?: Map<string, number> },
): Promise<RecordEnvelope> {
  const custom = (row.custom_fields ?? {}) as Record<string, unknown>;
  const values: Record<string, unknown> = {};

  for (const f of module.fields) {
    if (!f.isActive) continue;
    const raw = f.storage === 'column' ? row[f.columnName] : custom[f.columnName];
    values[f.name] = fromDbValue(f, raw ?? null);
  }

  // Engine-computed aggregates override whatever (possibly stale) value is stored.
  if (opts.rollups?.size) {
    for (const [name, v] of opts.rollups) values[name] = v;
  }

  // System fields are always present regardless of metadata.
  values.owner_id = row.owner_id ?? null;
  values.created_by = row.created_by ?? null;
  values.modified_by = row.modified_by ?? null;
  values.created_at = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
  values.updated_at = row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at;
  values.last_activity_at = row.last_activity_at instanceof Date
    ? row.last_activity_at.toISOString()
    : row.last_activity_at ?? null;

  const envelope: RecordEnvelope = {
    id: String(row.id),
    module: module.name,
    recordNumber: (row.record_number as string) ?? null,
    label: (row.label as string) ?? '',
    ownerId: (row.owner_id as string) ?? null,
    ownerType: (row.owner_type as 'user' | 'group') ?? 'user',
    createdBy: (row.created_by as string) ?? null,
    modifiedBy: (row.modified_by as string) ?? null,
    createdAt: String(values.created_at ?? ''),
    updatedAt: String(values.updated_at ?? ''),
    isDeleted: Boolean(row.is_deleted),
    values,
  };

  if (opts.withDisplay) {
    envelope.display = await resolveDisplayValues(module, values, opts.conn);
  }
  return envelope;
}

/**
 * Resolve human labels for reference/owner/user fields in one batched query so
 * a 100-row list view doesn't fan out into hundreds of lookups.
 */
async function resolveDisplayValues(
  module: ModuleMeta,
  values: Record<string, unknown>,
  conn: Tx,
): Promise<Record<string, string>> {
  const display: Record<string, string> = {};
  const recordIds = new Set<string>();
  const userIds = new Set<string>();

  for (const f of module.fields) {
    const v = values[f.name];
    if (isEmpty(v)) continue;
    if (f.uitype === 'reference') recordIds.add(String(v));
    else if (f.uitype === 'multireference' && Array.isArray(v)) v.forEach((x) => recordIds.add(String(x)));
    else if (f.uitype === 'user' || f.uitype === 'owner') userIds.add(String(v));
    else if (f.uitype === 'phone' && (f.config.digitsFrom || f.config.codePrefix)) {
      // A number reads as one value, so the code is joined here — once,
      // server-side — rather than in each of the list, detail, kanban and
      // export renderers. It comes from a country field where one exists, and
      // from the field's own `codePrefix` where it does not (migration 064).
      const code = f.config.digitsFrom
        ? String(values[String(f.config.digitsFrom)] ?? f.config.codePrefix ?? '')
        : String(f.config.codePrefix ?? '');
      display[f.name] = formatPhoneWithCode(code, String(v));
    } else if (f.uitype === 'area' && f.config.unitField) {
      display[f.name] = formatArea(Number(v), String(values[String(f.config.unitField)] ?? f.config.unit ?? 'sqft'));
    } else if (f.uitype === 'currency' && f.config.unitField) {
      // Budget / demand: the price and its qualifier (per Sq.ft., per Sq.yd.,
      // total) read as one value, exactly the area+unit pair above.
      const unit = String(values[String(f.config.unitField)] ?? '');
      display[f.name] = unit
        ? `${formatIndianPrice(Number(v))} ${unit === 'total' ? 'total' : `per ${unit === 'sqft' ? 'Sq.ft.' : 'Sq.yd.'}`}`
        : formatIndianPrice(Number(v));
    } else display[f.name] = formatValue(f, v);
  }
  if (values.owner_id) userIds.add(String(values.owner_id));
  if (values.created_by) userIds.add(String(values.created_by));
  if (values.modified_by) userIds.add(String(values.modified_by));

  const [recRes, userRes, groupRes] = await Promise.all([
    recordIds.size
      ? conn.query<{ id: string; label: string; module_name: string }>(
          `SELECT id, label, module_name FROM ipy_record WHERE id = ANY($1::uuid[])`,
          [[...recordIds]],
        )
      : Promise.resolve({ rows: [], rowCount: 0 }),
    userIds.size
      ? conn.query<{ id: string; name: string }>(
          `SELECT id, trim(first_name || ' ' || last_name) AS name FROM ipy_user WHERE id = ANY($1::uuid[])`,
          [[...userIds]],
        )
      : Promise.resolve({ rows: [], rowCount: 0 }),
    userIds.size
      ? conn.query<{ id: string; name: string }>(`SELECT id, name FROM ipy_group WHERE id = ANY($1::uuid[])`, [[...userIds]])
      : Promise.resolve({ rows: [], rowCount: 0 }),
  ]);

  const recMap = new Map(recRes.rows.map((r) => [r.id, r.label]));
  const recModuleMap = new Map(recRes.rows.map((r) => [r.id, r.module_name]));
  const principalMap = new Map<string, string>([
    ...userRes.rows.map((r) => [r.id, r.name] as [string, string]),
    ...groupRes.rows.map((r) => [r.id, r.name] as [string, string]),
  ]);

  for (const f of module.fields) {
    const v = values[f.name];
    if (isEmpty(v)) continue;
    if (f.uitype === 'reference') {
      display[f.name] = recMap.get(String(v)) ?? '';
      display[`${f.name}__module`] = recModuleMap.get(String(v)) ?? '';
    } else if (f.uitype === 'multireference' && Array.isArray(v)) {
      display[f.name] = v.map((x) => recMap.get(String(x)) ?? '').filter(Boolean).join(', ');
    } else if (f.uitype === 'user' || f.uitype === 'owner') {
      display[f.name] = principalMap.get(String(v)) ?? '';
    }
  }
  if (values.owner_id) display.owner_id = principalMap.get(String(values.owner_id)) ?? '';
  if (values.created_by) display.created_by = principalMap.get(String(values.created_by)) ?? '';
  if (values.modified_by) display.modified_by = principalMap.get(String(values.modified_by)) ?? '';

  return display;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export async function createRecord(
  ctx: ServiceContext,
  moduleName: string,
  input: Record<string, unknown>,
  opts: SaveOptions = {},
): Promise<RecordEnvelope> {
  const module = await registry.requireModule(moduleName);
  if (!ctx.system) await assertModuleAccess(ctx.user, moduleName, 'create');

  // Same reason as updateRecord: a renamed Assigned To must reach the owner
  // column, not the payload table, whatever the admin calls it.
  input = canonicaliseRecordFields(module, input);

  const run = async (conn: Tx): Promise<RecordEnvelope> => {
    const payload = ctx.system ? { ...input } : await filterWritableFields(ctx.user, moduleName, input);

    // Owner: explicit, else the creating user.
    const ownerId = (input.owner_id as string) ?? ctx.user.id;
    const ownerType = (input.owner_type as string) === 'group' ? 'group' : 'user';

    const prepared = await prepareValues(module, payload, { isCreate: true, conn });

    if (!opts.skipDuplicateCheck && module.duplicateCheckFields.length) {
      const dup = await findDuplicate(conn, module, prepared.values);
      if (dup) {
        throw new ConflictError(
          `A ${module.singularLabel.toLowerCase()} with the same ${module.duplicateCheckFields.join('/')} already exists`,
          { duplicateId: dup.id, duplicateLabel: dup.label },
        );
      }
    }

    const label = buildLabel(module, prepared.values);
    const searchText = buildSearchText(module, prepared.values);
    const recordNumber = prepared.recordNumber;

    const rec = await conn.queryOne<{ id: string }>(
      `INSERT INTO ipy_record
         (module_id, module_name, record_number, label, owner_id, owner_type,
          created_by, modified_by, search_text, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9)
       RETURNING id`,
      [module.id, module.name, recordNumber, label, ownerId, ownerType, ctx.user.id, searchText, ctx.source ?? 'app'],
    );
    if (!rec) throw new Error('failed to create record row');
    const recordId = rec.id;

    await insertPayload(conn, module, recordId, prepared);

    // Property folders are provisioned by the background worker. Queueing is
    // inside this transaction so a property can never commit without its
    // storage job, while the remote OneDrive call itself never delays capture.
    if (module.name === 'properties') {
      await conn.query(
        `INSERT INTO ipy_property_storage (record_id) VALUES ($1)
         ON CONFLICT (record_id) DO NOTHING`,
        [recordId],
      );
    }

    if (!opts.skipAudit) {
      await writeAudit(conn, {
        recordId,
        module: module.name,
        userId: ctx.user.id,
        action: 'create',
        changes: Object.entries(prepared.values)
          .filter(([, v]) => !isEmpty(v))
          .map(([field, to]) => ({
            field,
            label: module.fields.find((f) => f.name === field)?.label ?? field,
            from: null,
            to,
          })),
        source: ctx.source ?? 'app',
      });
    }

    const envelope = await getRecord({ ...ctx, system: true }, moduleName, recordId, { conn });

    // Queued rather than awaited: a workflow task that updates this same row
    // runs on a different connection and would block on our row lock until the
    // transaction commits. onCommit fires it immediately when there is no
    // transaction, and after COMMIT when there is.
    if (!opts.skipWorkflow) {
      onCommit(conn, () => emit('record.created', {
        module: moduleName,
        recordId,
        record: envelope.values,
        user: ctx.user,
        source: ctx.source ?? 'app',
      }));
    }
    return envelope;
  };

  if (opts.conn) return run(opts.conn);

  const envelope = await transaction(run);
  // Automation may have reassigned or scored the record, so return what is
  // actually stored rather than the pre-workflow snapshot.
  return opts.skipWorkflow ? envelope : getRecord({ ...ctx, system: true }, moduleName, envelope.id);
}

export async function updateRecord(
  ctx: ServiceContext,
  moduleName: string,
  recordId: string,
  input: Record<string, unknown>,
  opts: SaveOptions = {},
): Promise<RecordEnvelope> {
  const module = await registry.requireModule(moduleName);
  if (!ctx.system) {
    await assertModuleAccess(ctx.user, moduleName, 'edit');
    await assertRecordAccess(ctx, moduleName, recordId, 'edit');
  }

  // Before anything reads it: a record-level field an admin has renamed
  // arrives under their name, and everything below is keyed on the column.
  input = canonicaliseRecordFields(module, input);

  const run = async (conn: Tx): Promise<{ envelope: RecordEnvelope; changed: boolean }> => {
    const before = await getRecord({ ...ctx, system: true }, moduleName, recordId, { conn, withDisplay: false });
    const payload = ctx.system ? { ...input } : await filterWritableFields(ctx.user, moduleName, input);

    const prepared = await prepareValues(module, payload, { isCreate: false, conn, existing: before.values });

    const changes: { field: string; label: string; from: unknown; to: unknown }[] = [];
    for (const [field, to] of Object.entries(prepared.values)) {
      const from = before.values[field] ?? null;
      if (!valuesEqual(from, to)) {
        changes.push({
          field,
          label: module.fields.find((f) => f.name === field)?.label ?? field,
          from,
          to,
        });
      }
    }

    // `input` came through canonicaliseRecordFields above, so a renamed
    // Assigned To arrives as owner_id like any other caller's would.
    const ownerChanged = input.owner_id !== undefined && input.owner_id !== before.ownerId;
    if (changes.length === 0 && !ownerChanged) {
      // Nothing actually changed — skip the write, the audit row and the events.
      const unchanged = await getRecord({ ...ctx, system: true }, moduleName, recordId, { conn });
      return { envelope: unchanged, changed: false };
    }

    await updatePayload(conn, module, recordId, prepared);

    const merged = { ...before.values, ...prepared.values };
    const label = buildLabel(module, merged);
    const searchText = buildSearchText(module, merged);

    await conn.query(
      `UPDATE ipy_record
       SET label = $2, search_text = $3, modified_by = $4, updated_at = now()
           ${ownerChanged ? ', owner_id = $5, owner_type = $6' : ''}
       WHERE id = $1`,
      ownerChanged
        ? [recordId, label, searchText, ctx.user.id, input.owner_id, (input.owner_type as string) === 'group' ? 'group' : 'user']
        : [recordId, label, searchText, ctx.user.id],
    );

    if (!opts.skipAudit && (changes.length || ownerChanged)) {
      await writeAudit(conn, {
        recordId,
        module: module.name,
        userId: ctx.user.id,
        action: 'update',
        changes: ownerChanged
          ? [...changes, { field: 'owner_id', label: 'Owner', from: before.ownerId, to: input.owner_id }]
          : changes,
        source: ctx.source ?? 'app',
      });
    }

    const envelope = await getRecord({ ...ctx, system: true }, moduleName, recordId, { conn });

    // Deferred for the same reason as create — see onCommit in db/pool.ts.
    if (!opts.skipWorkflow) {
      onCommit(conn, async () => {
        await emit('record.updated', {
          module: moduleName,
          recordId,
          record: envelope.values,
          previous: before.values,
          changedFields: changes.map((c) => c.field),
          user: ctx.user,
          source: ctx.source ?? 'app',
        });
        if (ownerChanged) {
          await emit('record.owner_changed', {
            module: moduleName,
            recordId,
            record: envelope.values,
            previous: before.values,
            previousOwnerId: before.ownerId,
            user: ctx.user,
            source: ctx.source ?? 'app',
          });
        }
      });
    }
    return { envelope, changed: true };
  };

  if (opts.conn) return (await run(opts.conn)).envelope;

  const { envelope, changed } = await transaction(run);
  return changed && !opts.skipWorkflow
    ? getRecord({ ...ctx, system: true }, moduleName, recordId)
    : envelope;
}

export async function deleteRecord(
  ctx: ServiceContext,
  moduleName: string,
  recordId: string,
  opts: { hard?: boolean; conn?: Tx } = {},
): Promise<void> {
  const module = await registry.requireModule(moduleName);
  if (!ctx.system) {
    await assertModuleAccess(ctx.user, moduleName, 'delete');
    await assertRecordAccess(ctx, moduleName, recordId, 'delete');
  }
  const conn = opts.conn ?? db;

  const before = await getRecord({ ...ctx, system: true }, moduleName, recordId, { conn, withDisplay: false });

  if (opts.hard) {
    await conn.query(`DELETE FROM ipy_record WHERE id = $1`, [recordId]);
  } else {
    await conn.query(
      `UPDATE ipy_record SET is_deleted = true, deleted_at = now(), deleted_by = $2 WHERE id = $1`,
      [recordId, ctx.user.id],
    );
  }

  await writeAudit(conn, {
    recordId,
    module: module.name,
    userId: ctx.user.id,
    action: 'delete',
    changes: [],
    source: ctx.source ?? 'app',
  });

  // Deferred like create/update: no caller passes a transaction today, but the
  // `opts.conn` door is open, and emitting inline under one is the deadlock
  // this codebase has already paid for once — see onCommit in db/pool.ts.
  onCommit(conn, () => emit('record.deleted', {
    module: moduleName,
    recordId,
    record: before.values,
    user: ctx.user,
    source: ctx.source ?? 'app',
  }));
}

export async function restoreRecord(ctx: ServiceContext, moduleName: string, recordId: string): Promise<void> {
  await assertModuleAccess(ctx.user, moduleName, 'edit');
  await db.query(
    `UPDATE ipy_record SET is_deleted = false, deleted_at = NULL, deleted_by = NULL WHERE id = $1`,
    [recordId],
  );
  await writeAudit(db, {
    recordId, module: moduleName, userId: ctx.user.id, action: 'restore', changes: [], source: 'app',
  });
  /*
    The event bus and realtime.ts both know `record.restored` — a restored
    record should pop back into other users' lists the way a deleted one
    disappears — but nothing ever emitted it, so the restore reached only the
    screen that did it. This runs outside any transaction, so a direct emit
    is safe here (same shape as delete above uses onCommit for symmetry).
  */
  await emit('record.restored', {
    module: moduleName,
    recordId,
    record: (await getRecord({ ...ctx, system: true }, moduleName, recordId)).values,
    user: ctx.user,
    source: ctx.source ?? 'app',
  });
}

// ---------------------------------------------------------------------------
// Value preparation
// ---------------------------------------------------------------------------

interface PreparedValues {
  /** field name → coerced JS value */
  values: Record<string, unknown>;
  /** column name → db value, for the payload table */
  columns: Record<string, unknown>;
  
/** json key → value, merged into custom_fields */
  json: Record<string, unknown>;
  recordNumber: string | null;
}

/**
 * The name a record-level field is going by on this module.
 *
 * `owner_id` and its siblings do not live on the payload table — they are
 * columns on `ipy_record`, marked with `config.__record`. Everything that
 * writes them is keyed on the literal string 'owner_id', which is correct
 * exactly until an administrator renames the field, and renaming is something
 * this CRM promises they may do.
 *
 * On production the Assigned To field had been renamed from `owner_id` to
 * `assigned_to`, and the consequences were precisely split: reads worked,
 * because values are read out of the row by *column*, and every write failed,
 * because the payload split then tried to set `ipy_e_leads.owner_id` — a
 * column that is not there. The field showed the right owner and could not be
 * changed, with no error a person could act on.
 *
 * So the input is translated before anything else looks at it: whatever the
 * field is called, its value arrives under the column name the rest of the
 * pipeline already understands.
 */
function canonicaliseRecordFields(
  module: ModuleMeta,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const renamed = module.fields.filter(
    (f) => f.config.__record === true && f.storage === 'column' && f.name !== f.columnName,
  );
  if (!renamed.length) return input;

  const out = { ...input };
  for (const field of renamed) {
    if (!(field.name in out)) continue;
    // The admin's name wins only as a way in; downstream reads the column.
    out[field.columnName] = out[field.name];
    delete out[field.name];
  }
  return out;
}

async function prepareValues(
  module: ModuleMeta,
  input: Record<string, unknown>,
  opts: { isCreate: boolean; conn: Tx; existing?: Record<string, unknown> },
): Promise<PreparedValues> {
  const out: PreparedValues = { values: {}, columns: {}, json: {}, recordNumber: null };
  const fieldMap = new Map(module.fields.map((f) => [f.name, f]));
  input = canonicaliseRecordFields(module, input);

  // 1. coerce everything the caller supplied
  for (const [key, raw] of Object.entries(input)) {
    if (key === 'owner_id' || key === 'owner_type') continue;
    const field = fieldMap.get(key);
    if (!field || !field.isActive) continue;
    if (field.displayType === 'detail_only') continue;
    if (!opts.isCreate && field.displayType === 'create_only') continue;
    if (UITYPES[field.uitype]?.computed) continue;

    const coerced = coerceValue(field, raw);
    if (coerced === undefined) continue;
    out.values[key] = coerced;
  }

  // 2. defaults on create
  if (opts.isCreate) {
    for (const field of module.fields) {
      if (!field.isActive || field.name in out.values) continue;
      if (field.defaultValue !== null && field.defaultValue !== undefined) {
        out.values[field.name] = coerceValue(field, field.defaultValue);
      } else if ((field.uitype === 'picklist' || field.uitype === 'radio') && field.options?.length) {
        const def = field.options.find((o) => o.isDefault);
        if (def) out.values[field.name] = def.value;
      }
    }
  }

  // 3. validation
  validateRequired(
    module.fields,
    opts.isCreate ? out.values : input,
    opts.isCreate,
    { ...(opts.existing ?? {}), ...out.values },
    module.requireOneOf,
  );
  // Format, range and cross-field rules, against the stored record merged with
  // this payload — a partial update of "budget from" must still be checked
  // against the "budget to" already on the record.
  validateValues(module.fields, out.values, { ...(opts.existing ?? {}), ...out.values });

  // 4. uniqueness
  for (const field of module.fields) {
    if (!field.isUnique || !(field.name in out.values)) continue;
    const v = out.values[field.name];
    if (isEmpty(v)) continue;
    const exists = await opts.conn.queryOne<{ id: string }>(
      `SELECT r.id FROM ipy_record r
       JOIN ${quoteIdent(module.tableName)} e ON e.record_id = r.id
       WHERE r.module_id = $1 AND r.is_deleted = false AND ${fieldExpr(field)} = $2
       LIMIT 1`,
      [module.id, v],
    );
    if (exists) {
      throw new ValidationError(`${field.label} must be unique — '${String(v)}' is already used`, { field: field.name });
    }
  }

  // 5. computed fields
  const merged = { ...(opts.existing ?? {}), ...out.values };
  for (const field of module.fields) {
    if (!field.isActive) continue;
    if (field.uitype === 'autonumber' && opts.isCreate) {
      const num = await nextNumber(module.name, field.name, field.config.numbering ?? {}, opts.conn);
      out.values[field.name] = num;
      if (!out.recordNumber) out.recordNumber = num;
    } else if (field.uitype === 'formula' && field.config.formula?.expression) {
      const result = evaluateFormula(field.config.formula.expression, merged);
      if (result !== undefined) out.values[field.name] = result;
    }
  }

  // 6. split into column vs json storage
  for (const [name, value] of Object.entries(out.values)) {
    const field = fieldMap.get(name);
    if (!field) continue;
    const dbValue = toDbValue(field, value);
    if (field.storage === 'column') out.columns[field.columnName] = dbValue;
    else out.json[field.columnName] = value;
  }

  return out;
}

async function insertPayload(conn: Tx, module: ModuleMeta, recordId: string, prepared: PreparedValues): Promise<void> {
  const cols = ['record_id', ...Object.keys(prepared.columns)];
  const vals: unknown[] = [recordId, ...Object.values(prepared.columns)];
  if (Object.keys(prepared.json).length) {
    cols.push('custom_fields');
    vals.push(JSON.stringify(prepared.json));
  }
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
  await conn.query(
    `INSERT INTO ${quoteIdent(module.tableName)} (${cols.map(quoteIdent).join(', ')}) VALUES (${placeholders})`,
    vals,
  );
}

async function updatePayload(conn: Tx, module: ModuleMeta, recordId: string, prepared: PreparedValues): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [recordId];
  for (const [col, val] of Object.entries(prepared.columns)) {
    vals.push(val);
    sets.push(`${quoteIdent(col)} = $${vals.length}`);
  }
  if (Object.keys(prepared.json).length) {
    vals.push(JSON.stringify(prepared.json));
    // Shallow-merge so untouched custom fields survive a partial update.
    sets.push(`custom_fields = COALESCE(custom_fields, '{}'::jsonb) || $${vals.length}::jsonb`);
  }
  if (!sets.length) return;
  await conn.query(
    `UPDATE ${quoteIdent(module.tableName)} SET ${sets.join(', ')} WHERE record_id = $1`,
    vals,
  );
}

// ---------------------------------------------------------------------------
// Labels, search text, duplicates
// ---------------------------------------------------------------------------

export function buildLabel(module: ModuleMeta, values: Record<string, unknown>): string {
  const parts = module.labelFields
    .map((name) => values[name])
    .filter((v) => !isEmpty(v))
    .map((v) => String(v).trim());
  const label = parts.join(' ').trim();
  if (label) return label.slice(0, 300);
  const fallback = values.name ?? values.subject ?? values.title ?? values.record_number;
  return fallback ? String(fallback).slice(0, 300) : `${module.singularLabel}`;
}

/**
 * What the search box can match this record on.
 *
 * Phone numbers are in here whether or not anybody ticked "searchable" on the
 * field. Pasting a missed call into the search box is the single most common
 * lookup on a property desk, and it silently returned nothing: `mobile` is not
 * a searchable field in the seed, so no lead could be found by its number —
 * by its owner or by anyone else. That reads exactly like a permissions
 * problem, and it was reported as one.
 *
 * Both forms go in. The stored value may be `9811421156` while the caller ID
 * says `+91 98114 21156`, and the tokeniser treats those as different words,
 * so the digits-only form is appended alongside whatever was typed.
 */
function buildSearchText(module: ModuleMeta, values: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const f of module.fields) {
    if (!f.isActive) continue;
    const phone = f.uitype === 'phone';
    if (!f.searchable && !phone) continue;
    const v = values[f.name];
    if (isEmpty(v)) continue;
    const raw = Array.isArray(v) ? v.join(' ') : String(v);
    parts.push(raw);
    if (phone) {
      const digits = raw.replace(/\D/g, '');
      if (digits && digits !== raw) parts.push(digits);
    }
  }
  return parts.join(' ').slice(0, 4000);
}

/**
 * The record this row would collide with, if there is one.
 *
 * The create path throws a `ConflictError` carrying the same id, which is
 * enough when the answer is "don't create it". An import that is *updating*
 * has to know before it writes, because finding out afterwards means the
 * record has already been created and there is nothing to undo it with.
 */
export async function findDuplicateRecord(
  moduleName: string,
  values: Record<string, unknown>,
): Promise<{ id: string; label: string } | null> {
  const module = await registry.requireModule(moduleName);
  if (!module.duplicateCheckFields.length) return null;
  const prepared = await prepareValues(module, values, { isCreate: true, conn: db });
  return findDuplicate(db, module, prepared.values);
}

async function findDuplicate(
  conn: Tx,
  module: ModuleMeta,
  values: Record<string, unknown>,
): Promise<{ id: string; label: string } | null> {
  const conditions: string[] = [];
  const params: unknown[] = [module.id];
  const composite = module.duplicateCheckMode === 'all';

  for (const name of module.duplicateCheckFields) {
    const field = module.fields.find((f) => f.name === name);
    if (!field) continue;
    const v = values[name];
    if (isEmpty(v)) {
      /*
        A composite identity with a hole in it is not an identity.

        Under `all`, a blank part would silently shrink the key — leave the floor
        out and every unit in the building matches. Refusing to judge is right:
        the record saves, and the form's duplicate panel still shows anything
        worth a second look.
      */
      if (composite) return null;
      continue;
    }
    params.push(v);
    conditions.push(`${fieldExpr(field)} = $${params.length}`);
  }
  if (!conditions.length) return null;

  // `any` — each field alone identifies the record (the same mobile is the same
  // person). `all` — the fields together do (locality, house number and floor
  // are one physical unit; any one of them alone is a whole street).
  const joiner = composite ? ' AND ' : ' OR ';
  return conn.queryOne<{ id: string; label: string }>(
    `SELECT r.id, r.label FROM ipy_record r
     JOIN ${quoteIdent(module.tableName)} e ON e.record_id = r.id
     WHERE r.module_id = $1 AND r.is_deleted = false AND (${conditions.join(joiner)})
     LIMIT 1`,
    params,
  );
}

/** Public duplicate probe used by the UI's "possible duplicates" panel. */
export async function findPossibleDuplicates(
  moduleName: string,
  values: Record<string, unknown>,
  excludeId?: string,
): Promise<{ id: string; label: string; matchedOn: string[] }[]> {
  const module = await registry.requireModule(moduleName);
  const checks: { field: FieldMeta; value: unknown }[] = [];
  for (const name of module.duplicateCheckFields) {
    const field = module.fields.find((f) => f.name === name);
    if (field && !isEmpty(values[name])) checks.push({ field, value: values[name] });
  }
  if (!checks.length) return [];

  const params: unknown[] = [module.id];
  const parts = checks.map(({ field, value }) => {
    params.push(value);
    return `CASE WHEN ${fieldExpr(field)} = $${params.length} THEN '${field.name}' ELSE NULL END`;
  });
  // Same combining rule as the save-time check, so the panel never warns about
  // something the save accepts, or stays quiet about something it refuses.
  if (module.duplicateCheckMode === 'all' && checks.length !== module.duplicateCheckFields.length) return [];
  const joiner = module.duplicateCheckMode === 'all' ? ' AND ' : ' OR ';
  const where = checks.map(({ field }, i) => `${fieldExpr(field)} = $${i + 2}`).join(joiner);
  if (excludeId) params.push(excludeId);

  const res = await db.query<{ id: string; label: string; matched: (string | null)[] }>(
    `SELECT r.id, r.label, ARRAY[${parts.join(',')}] AS matched
     FROM ipy_record r
     JOIN ${quoteIdent(module.tableName)} e ON e.record_id = r.id
     WHERE r.module_id = $1 AND r.is_deleted = false AND (${where})
     ${excludeId ? `AND r.id <> $${params.length}::uuid` : ''}
     LIMIT 5`,
    params,
  );
  return res.rows.map((r) => ({
    id: r.id,
    label: r.label,
    matchedOn: (r.matched ?? []).filter((x): x is string => Boolean(x)),
  }));
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined || b === '';
  if (b === null || b === undefined) return a === '';
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => String(x) === String(b[i]));
  }
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return String(a) === String(b);
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface AuditInput {
  recordId: string | null;
  module: string;
  userId: string | null;
  action: string;
  changes: unknown[];
  source: string;
  ip?: string;
}

export async function writeAudit(conn: Tx, entry: AuditInput): Promise<void> {
  try {
    await conn.query(
      `INSERT INTO ipy_audit (record_id, module_name, user_id, action, changes, source, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [entry.recordId, entry.module, entry.userId, entry.action, JSON.stringify(entry.changes), entry.source, entry.ip ?? null],
    );
  } catch (err) {
    // Audit must never take down a write.
    logger.error({ err, entry }, 'failed to write audit entry');
  }
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

interface ViewRow {
  id: string;
  columns: string[];
  filter: FilterGroup;
  sort_by: string | null;
  sort_dir: string;
}

async function loadView(
  conn: Tx,
  moduleId: string,
  viewIdOrName: string,
  userId: string,
  unrestricted: boolean,
): Promise<ViewRow | null> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(viewIdOrName);
  return conn.queryOne<ViewRow>(
    `SELECT id, columns, filter, sort_by, sort_dir
     FROM ipy_view
     WHERE module_id = $1 AND ${isUuid ? 'id = $2::uuid' : 'name = $2'}
       AND ($3 OR is_system OR is_public OR owner_id = $4)
     LIMIT 1`,
    [moduleId, viewIdOrName, unrestricted, userId],
  );
}

export function mergeFilters(a: FilterGroup | undefined, b: FilterGroup | undefined): FilterGroup | undefined {
  const aHas = a?.conditions?.length;
  const bHas = b?.conditions?.length;
  if (!aHas && !bHas) return undefined;
  if (!aHas) return b;
  if (!bHas) return a;
  return { logic: 'AND', conditions: [a!, b!] };
}

// ---------------------------------------------------------------------------
// Bulk helpers
// ---------------------------------------------------------------------------

/**
 * The same edit applied to many records.
 *
 * Automations are **off by default**, and that is the whole difference between
 * this working and this "not working out well". Setting Lead Status to New
 * across a desk's whole list is a tidy-up, not five hundred new leads arriving
 * — but every one of those saves fires the new-lead rules through the workflow
 * engine, which queues a WhatsApp greeting each, re-scores each, and raises a
 * first-call task each. It is also where nearly all the time goes: the same
 * hundred records take about a fifth as long with the engine out of the loop,
 * which is the difference between a request that answers and one that is still
 * running when the browser gives up.
 *
 * Exactly the contract the CSV import already uses, and for the same reason —
 * see the `runWorkflows` flag on the import route. One tick turns them on for
 * the day somebody wants them.
 *
 * A failure is per record and never stops the run: the ones that could be
 * saved are saved, and every reason comes back so the caller can say what went
 * wrong rather than only how many.
 */
export async function massUpdate(
  ctx: ServiceContext,
  moduleName: string,
  recordIds: string[],
  values: Record<string, unknown>,
  opts: { runWorkflows?: boolean } = {},
): Promise<{ updated: number; failed: { id: string; error: string }[]; reasons: string[] }> {
  const failed: { id: string; error: string }[] = [];
  let updated = 0;
  for (const id of recordIds) {
    try {
      await updateRecord(ctx, moduleName, id, values, { skipWorkflow: !opts.runWorkflows });
      updated++;
    } catch (err) {
      failed.push({ id, error: err instanceof Error ? err.message : 'unknown error' });
    }
  }
  // Five hundred rows rejected for one reason is one sentence, not five
  // hundred. The distinct reasons, commonest first, are what a person can act
  // on — "Lead Status is required" says which record to look at and why.
  const counts = new Map<string, number>();
  for (const f of failed) counts.set(f.error, (counts.get(f.error) ?? 0) + 1);
  const reasons = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, n]) => (n > 1 ? `${reason} (${n} records)` : reason));

  return { updated, failed, reasons };
}

/**
 * Every record id the query matches — the ids behind "select all in this view".
 *
 * Resolved through `listRecords` on purpose: that path already enforces the
 * saved view, the ad-hoc filter, profile scoping and field visibility, so a
 * bulk action cannot reach a record the same user could not have opened. A
 * hand-written query here would be a second permission model that drifts.
 */
export async function idsForQuery(
  ctx: ServiceContext,
  moduleName: string,
  q: ListQuery,
  max = 5000,
): Promise<string[]> {
  const ids: string[] = [];
  for (let page = 1; ids.length < max; page++) {
    const res = await listRecords(ctx, moduleName, { ...q, page, pageSize: 500, columns: ['id'] });
    for (const row of res.rows) ids.push(row.id);
    if (page * 500 >= res.total) break;
  }
  return ids.slice(0, max);
}

/**
 * Bulk edit everything a view/filter matches — the "select all conversations
 * in this search" of Gmail, applied to records.
 *
 * The cap is a safety stop, not a design limit: a bulk edit over an
 * unbounded result set is a workflow nobody can review, and the response says
 * how many matched so the caller can narrow rather than guess.
 */
export async function massUpdateByQuery(
  ctx: ServiceContext,
  moduleName: string,
  q: ListQuery,
  values: Record<string, unknown>,
  opts: { runWorkflows?: boolean } = {},
  max = 5000,
): Promise<{ updated: number; failed: { id: string; error: string }[]; reasons: string[]; matched: number; capped: boolean }> {
  const ids = await idsForQuery(ctx, moduleName, q, max);
  const result = await massUpdate(ctx, moduleName, ids, values, opts);
  return { ...result, matched: ids.length, capped: ids.length >= max };
}

export async function massDelete(
  ctx: ServiceContext,
  moduleName: string,
  recordIds: string[],
): Promise<{ deleted: number; failed: { id: string; error: string }[] }> {
  const failed: { id: string; error: string }[] = [];
  let deleted = 0;
  for (const id of recordIds) {
    try {
      await deleteRecord(ctx, moduleName, id);
      deleted++;
    } catch (err) {
      failed.push({ id, error: err instanceof Error ? err.message : 'unknown error' });
    }
  }
  return { deleted, failed };
}

/**
 * Bulk reassignment may only hand records to an Administrator. A single
 * reassign already goes through the normal owner-field picklist of users the
 * caller can see; bulk moves an entire book of business in one click, with no
 * per-record review, so it is scoped tighter on purpose — to the one role a
 * departing or reorganising rep's records can always land on safely.
 * Administrator is depth 0 in ipy_role.path (see rbac.ts), which is more
 * robust to a role rename than matching on the name string.
 */
async function assertAdministratorRole(userId: string): Promise<void> {
  const row = await db.queryOne<{ depth: number; is_admin: boolean }>(
    `SELECT r.depth, u.is_admin
       FROM ipy_user u LEFT JOIN ipy_role r ON r.id = u.role_id
      WHERE u.id = $1`,
    [userId],
  );
  if (!row || (row.depth !== 0 && !row.is_admin)) {
    throw new ForbiddenError('Bulk reassignment can only be given to an Administrator');
  }
}

export async function transferOwnership(
  ctx: ServiceContext,
  moduleName: string,
  recordIds: string[],
  newOwnerId: string,
  ownerType: 'user' | 'group' = 'user',
): Promise<number> {
  if (ownerType === 'user') {
    await assertAdministratorRole(newOwnerId);
  }
  let count = 0;
  for (const id of recordIds) {
    await updateRecord(ctx, moduleName, id, { owner_id: newOwnerId, owner_type: ownerType });
    count++;
  }
  return count;
}

/** Bump last_activity_at — called whenever a call/message/visit touches a record. */
export async function touchActivity(recordId: string, conn: Tx = db): Promise<void> {
  await conn.query(`UPDATE ipy_record SET last_activity_at = now() WHERE id = $1`, [recordId]);
}

/** Lightweight lookup for reference pickers and AI tools. */
export async function lookupRecords(
  ctx: ServiceContext,
  moduleName: string,
  term: string,
  limit = 20,
  extraFilter?: FilterGroup,
): Promise<{ id: string; label: string; recordNumber: string | null; subtitle?: string }[]> {
  const module = await registry.requireModule(moduleName);
  const params = new SqlParams();
  const clauses = [
    `${RECORD_ALIAS}.module_id = ${params.add(module.id)}::uuid`,
    `${RECORD_ALIAS}.is_deleted = false`,
  ];
  if (term.trim()) clauses.push(buildSearchClause(term, params));
  if (extraFilter) {
    const where = await buildWhere(module, extraFilter, params, {
      userId: ctx.user.id, groupIds: ctx.groupIds, subordinateIds: ctx.subordinateIds,
    });
    if (where.sql) clauses.push(where.sql);
  }
  if (!ctx.system) {
    const scope = await recordScopeSql(ctx, moduleName, params);
    if (scope) clauses.push(scope);
  }
  const limitParam = params.add(limit);
  const res = await db.query<{ id: string; label: string; record_number: string | null }>(
    `SELECT ${RECORD_ALIAS}.id, ${RECORD_ALIAS}.label, ${RECORD_ALIAS}.record_number
     FROM ipy_record ${RECORD_ALIAS}
     JOIN ${quoteIdent(module.tableName)} ${ENTITY_ALIAS} ON ${ENTITY_ALIAS}.record_id = ${RECORD_ALIAS}.id
     WHERE ${clauses.join(' AND ')}
     ORDER BY ${RECORD_ALIAS}.updated_at DESC
     LIMIT ${limitParam}`,
    params.all(),
  );
  return res.rows.map((r) => ({ id: r.id, label: r.label, recordNumber: r.record_number }));
}

export interface SearchHit {
  id: string;
  module: string;
  moduleLabel: string;
  label: string;
  recordNumber: string | null;
  /**
   * A number that exists in the CRM on a record this user cannot open.
   *
   * Carries a name and an owner and nothing else — no id to follow, no
   * fields. See `assignedNumberLookup`.
   */
  restricted?: true;
  ownerName?: string | null;
}

/**
 * Is this number already on somebody's record, and whose?
 *
 * Runs **outside** the searcher's record scope on purpose — that is the whole
 * point, and it is why the answer is cut down to two facts. What comes back is
 * a name and an owner. There is no record id in it, so the UI has nothing to
 * link to; no field values, so the mobile itself is never re-served to someone
 * a profile has masked it from.
 *
 * Guards that keep this from becoming a back door:
 *
 *  * **Phone-shaped terms only** — eight digits or more. A name, a locality or
 *    a budget goes nowhere near this path, so it cannot be used to browse.
 *  * **Digits compared to digits.** The stored value may be `9811421156`,
 *    `+91 98114 21156` or `098114-21156`; a `LIKE` on the raw column matches
 *    the first and misses the rest, which would report "not taken" for a number
 *    that is.
 *  * **The last eight digits.** Indian mobiles are ten, and the pair that
 *    differs between a stored `+91…` and a typed `0…` is at the front.
 *  * **Phone fields only**, found by uitype, so an admin adding "Alternate
 *    number" tomorrow is covered and a text field holding an invoice number
 *    is not.
 */
async function assignedNumberLookup(
  ctx: ServiceContext,
  term: string,
  labelByName: Map<string, string>,
): Promise<SearchHit | null> {
  const digits = term.replace(/\D/g, '');
  if (digits.length < 8) return null;
  const tail = digits.slice(-8);

  const modules = await registry.getModules({ entityOnly: true });
  for (const module of modules) {
    const phoneFields = module.fields.filter((f) => f.uitype === 'phone' && f.isActive);
    if (!phoneFields.length) continue;

    // right(digits-only, 8) = the typed tail. Written per field rather than
    // concatenated so a null in one column cannot swallow the row. A JSON
    // field's key is bound, not interpolated — it is metadata, but nothing in
    // this file interpolates a value into SQL and this is not the place to
    // start the exception.
    const params: unknown[] = [module.id, tail];
    const clauses = phoneFields.map((f) => {
      let expr: string;
      if (f.storage === 'json') {
        params.push(f.columnName);
        expr = `e.custom_fields->>$${params.length}`;
      } else {
        expr = `e.${quoteIdent(f.columnName)}`;
      }
      return `right(regexp_replace(coalesce(${expr}, ''), '\\D', '', 'g'), 8) = $2`;
    });

    const row = await db.queryOne<{ label: string; owner_name: string | null }>(
      `SELECT r.label, nullif(trim(u.first_name || ' ' || u.last_name), '') AS owner_name
         FROM ipy_record r
         JOIN ${quoteIdent(module.tableName)} e ON e.record_id = r.id
         LEFT JOIN ipy_user u ON u.id = r.owner_id
        WHERE r.module_id = $1 AND r.is_deleted = false AND (${clauses.join(' OR ')})
        ORDER BY r.updated_at DESC
        LIMIT 1`,
      params,
    );
    if (!row) continue;

    logger.info(
      { userId: ctx.user.id, module: module.name },
      'search revealed an out-of-scope number as assigned',
    );
    return {
      id: `restricted:${module.name}`,
      module: module.name,
      moduleLabel: labelByName.get(module.name) ?? module.name,
      label: row.label,
      recordNumber: null,
      restricted: true,
      ownerName: row.owner_name,
    };
  }
  return null;
}

/** Global search across every module the user can see. */
export async function globalSearch(
  ctx: ServiceContext,
  term: string,
  limit = 20,
): Promise<SearchHit[]> {
  if (!term.trim()) return [];
  const modules = await registry.getModules({ entityOnly: true });
  const allowed: ModuleMeta[] = [];
  for (const m of modules) {
    const perm = await import('../permissions/index.js').then((p) => p.canAccessModule(ctx.user, m.name, 'view'));
    if (perm) allowed.push(m);
  }
  if (!allowed.length) return [];

  const params = new SqlParams();
  const search = buildSearchClause(term, params);

  // Sharing is configured per module — leads/deals are private while
  // projects/properties are public_read — so one module's scope fragment must
  // never be applied to another's rows. Scope each module independently and OR
  // the branches together; a null scope means that module is unrestricted for
  // this user.
  const branches: string[] = [];
  for (const m of allowed) {
    const moduleParam = params.add(m.id);
    const scope = ctx.system ? null : await recordScopeSql(ctx, m.name, params);
    branches.push(
      scope
        ? `(${RECORD_ALIAS}.module_id = ${moduleParam}::uuid AND ${scope})`
        : `${RECORD_ALIAS}.module_id = ${moduleParam}::uuid`,
    );
  }

  const limitParam = params.add(limit);

  const res = await db.query<{ id: string; module_name: string; label: string; record_number: string | null }>(
    `SELECT ${RECORD_ALIAS}.id, ${RECORD_ALIAS}.module_name, ${RECORD_ALIAS}.label, ${RECORD_ALIAS}.record_number
     FROM ipy_record ${RECORD_ALIAS}
     WHERE (${branches.join(' OR ')})
       AND ${RECORD_ALIAS}.is_deleted = false
       AND ${search}
     ORDER BY ${RECORD_ALIAS}.updated_at DESC
     LIMIT ${limitParam}`,
    params.all(),
  );

  const labelByName = new Map(modules.map((m) => [m.name, m.label]));
  const found: SearchHit[] = res.rows.map((r) => ({
    id: r.id,
    module: r.module_name,
    moduleLabel: labelByName.get(r.module_name) ?? r.module_name,
    label: r.label,
    recordNumber: r.record_number,
  }));

  /*
    "Nobody has this number" and "you cannot see who does" look identical from
    the search box, and only one of them is true. A rep who dials a number
    the desk already owns has cold-called a colleague's customer, which is the
    single most expensive avoidable mistake on a property desk.

    So a phone-shaped search that found nothing gets one extra, deliberately
    tiny answer: the name on the record and who it is assigned to. No id, so
    there is nothing to open; no fields, so there is nothing to read. And it
    only fires on a number the searcher already had in their hand, which is
    why it cannot be used to build a list of numbers.
  */
  if (!ctx.system && !found.length) {
    const assigned = await assignedNumberLookup(ctx, term, labelByName);
    if (assigned) found.push(assigned);
  }

  /**
   * When the words did not match, try the meaning.
   *
   * Only when the keyword pass came back thin *and* what was typed reads like a
   * phrase rather than a prefix. Somebody typing "sha" on the way to "Sharma"
   * wants the instant list, not an embedding call per keystroke — and the
   * models that do this well are free ones with rate limits worth spending on
   * the searches that actually failed.
   */
  const phrase = term.trim().split(/\s+/).length >= 3 || term.trim().length >= 15;
  if (found.length >= 5 || !phrase || ctx.system) return found;

  const { search: semanticSearch } = await import('../search/semantic.js');
  const hits = await semanticSearch(term, ctx, { top: limit - found.length })
    .catch(() => []);

  const seen = new Set(found.map((r) => r.id));
  for (const hit of hits) {
    if (seen.has(hit.recordId)) continue;
    seen.add(hit.recordId);
    found.push({
      id: hit.recordId,
      module: hit.moduleName,
      moduleLabel: labelByName.get(hit.moduleName) ?? hit.moduleName,
      label: hit.label,
      recordNumber: null,
    });
  }
  return found.slice(0, limit);
}

export const recordService = {
  getRecord,
  listRecords,
  createRecord,
  updateRecord,
  findDuplicateRecord,
  deleteRecord,
  restoreRecord,
  massUpdate,
  massUpdateByQuery,
  idsForQuery,
  massDelete,
  transferOwnership,
  lookupRecords,
  globalSearch,
  findPossibleDuplicates,
  touchActivity,
  writeAudit,
  buildLabel,
};
