import type { FieldMeta } from '@ipropy/shared';
import { db, transaction } from '../db/pool.js';
import { registry } from '../core/metadata/registry.js';
import { canAccessRecord, getFieldPermissions } from '../core/permissions/index.js';
import {
  getRecord, globalSearch, updateRecord, type ServiceContext,
} from '../core/entity/recordService.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors.js';
import { completeJson, isAiAvailable } from './client.js';

export interface AssistantActionProposal {
  id: string;
  type: 'update_record';
  summary: string;
  module: string;
  recordId: string;
  recordLabel: string;
  changes: { field: string; label: string; from: unknown; to: unknown }[];
  status: 'pending' | 'confirmed' | 'cancelled' | 'expired';
  expiresAt: string;
}

export interface AssistantRecordChoice {
  id: string;
  module: string;
  moduleLabel: string;
  label: string;
  recordNumber: string | null;
}

export interface AssistantActionPlanResult {
  handled: boolean;
  answer?: string;
  action?: AssistantActionProposal;
  choices?: AssistantRecordChoice[];
}

interface ModelActionPlan {
  isAction?: boolean;
  module?: string | null;
  recordSearch?: string | null;
  updates?: Record<string, unknown>;
  summary?: string;
}

interface ActionRow {
  id: string;
  user_id: string;
  thread_id: string;
  action_type: 'update_record';
  module_name: string;
  record_id: string;
  payload: { updates?: Record<string, unknown>; changes?: AssistantActionProposal['changes']; recordLabel?: string };
  preview: string;
  status: AssistantActionProposal['status'];
  expires_at: string;
}

const MUTATION_WORDS = /\b(?:mark|set|change|update|move|assign|rename|correct|make)\b/i;

function describeField(field: FieldMeta): string {
  const choices = field.options?.length
    ? `; allowed values: ${field.options.slice(0, 30).map((option) => `${option.value} (${option.label})`).join(', ')}`
    : '';
  return `- ${field.name}: ${field.label} [${field.uitype}]${choices}`;
}

function normalizePicklistValue(field: FieldMeta, value: unknown): unknown | undefined {
  if (!field.options?.length) return value;
  const wanted = String(value).trim().toLocaleLowerCase('en-IN');
  const option = field.options.find((candidate) => (
    candidate.value.toLocaleLowerCase('en-IN') === wanted
    || candidate.label.toLocaleLowerCase('en-IN') === wanted
  ));
  return option?.value;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function proposalFromRow(row: ActionRow): AssistantActionProposal {
  return {
    id: row.id,
    type: row.action_type,
    summary: row.preview,
    module: row.module_name,
    recordId: row.record_id,
    recordLabel: row.payload.recordLabel ?? 'CRM record',
    changes: row.payload.changes ?? [],
    status: row.status,
    expiresAt: String(row.expires_at),
  };
}

/**
 * Plan a narrow, reversible CRM update. Read-only questions skip this function
 * without an AI call; mutating language gets a schema-grounded plan. The plan
 * is validated and stored, but never executed here.
 */
export async function planAssistantAction(
  question: string,
  ctx: ServiceContext,
  threadId: string,
  context?: { recordId?: string; module?: string },
): Promise<AssistantActionPlanResult> {
  if (!isAiAvailable() || !MUTATION_WORDS.test(question)) return { handled: false };

  const modules = context?.module
    ? (await registry.getModules({ entityOnly: true })).filter((module) => module.name === context.module)
    : await registry.getModules({ entityOnly: true });

  const descriptions = await Promise.all(modules.map(async (module) => {
    const writable = await registry.getWritableFields(module.name);
    return `## ${module.name} (${module.singularLabel})\n${writable.slice(0, 55).map(describeField).join('\n')}`;
  }));

  let contextRecord = '';
  if (context?.recordId && context.module) {
    try {
      const record = await getRecord(ctx, context.module, context.recordId, { withDisplay: false });
      contextRecord = `The currently open record is ${record.label} (${record.recordNumber ?? record.id}) in ${context.module}.`;
    } catch {
      return { handled: true, answer: 'I cannot open or change the record currently on screen.' };
    }
  }

  const planned = await completeJson<ModelActionPlan>({
    feature: 'assistant_action_plan',
    fast: true,
    maxTokens: 900,
    temperature: 0,
    userId: ctx.user.id,
    system: `You plan updates inside iPropy CRM. Never answer general questions. Never invent modules, fields, records or picklist values. A question is an action only when the user clearly commands a change. Questions asking what, which, how many, why, show or summarise are not actions. Only plan update_record-style changes; never delete records, send messages, publish content or trigger external systems. Return JSON only.`,
    prompt: `User instruction: ${JSON.stringify(question)}
${contextRecord}

Available writable CRM fields:
${descriptions.join('\n\n')}

Return:
{
  "isAction": true or false,
  "module": "exact module name or null",
  "recordSearch": "record number, property code, name, phone or other text that identifies the record; null only when the user clearly means the currently open record",
  "updates": { "exact_field_name": "new value" },
  "summary": "short plain-English description"
}

Use exact option values shown above. Do not include unchanged information or system fields.`,
  });

  if (!planned?.isAction) return { handled: false };
  if (context?.module && planned.module && planned.module !== context.module) {
    return {
      handled: true,
      answer: `This chat is attached to the ${context.module.replace(/_/g, ' ')} record you opened. Start a new chat before changing a record in another CRM section.`,
    };
  }
  const plannedSearch = String(planned.recordSearch ?? '').trim();
  const useOpenRecord = Boolean(
    context?.recordId
    && context.module
    && !plannedSearch
    && (!planned.module || planned.module === context.module),
  );
  const moduleName = planned.module ?? context?.module ?? '';
  const module = await registry.getModule(moduleName);
  if (!module) {
    return { handled: true, answer: 'I understood this as a CRM change, but I could not identify the correct CRM section.' };
  }

  let recordId = useOpenRecord ? context?.recordId : undefined;
  let recordLabel: string | undefined;
  if (!recordId) {
    const term = plannedSearch;
    if (!term) {
      return { handled: true, answer: `Please name the ${module.singularLabel.toLowerCase()} you want me to change.` };
    }
    const matches = (await globalSearch(ctx, term, 12)).filter((item) => item.module === moduleName);
    const normalized = term.toLocaleLowerCase('en-IN');
    const exact = matches.filter((item) => (
      item.recordNumber?.toLocaleLowerCase('en-IN') === normalized
      || item.label.toLocaleLowerCase('en-IN') === normalized
    ));
    const candidates = exact.length === 1 ? exact : matches;
    if (candidates.length !== 1) {
      return {
        handled: true,
        answer: candidates.length
          ? `I found more than one matching ${module.singularLabel.toLowerCase()}. Open the right one or mention its exact record number, then ask again.`
          : `I could not find a ${module.singularLabel.toLowerCase()} matching “${term}” in the records you can access.`,
        choices: candidates.slice(0, 8),
      };
    }
    recordId = candidates[0].id;
    recordLabel = candidates[0].label;
  }

  if (!(await canAccessRecord(ctx, moduleName, recordId, 'edit'))) {
    return { handled: true, answer: `You can view that ${module.singularLabel.toLowerCase()}, but you do not have permission to change it.` };
  }

  const record = await getRecord(ctx, moduleName, recordId, { withDisplay: false });
  recordLabel = recordLabel ?? record.label;
  const fieldPermissions = await getFieldPermissions(ctx.user, moduleName);
  const writable = new Map((await registry.getWritableFields(moduleName)).map((field) => [field.name, field]));
  const updates: Record<string, unknown> = {};
  const changes: AssistantActionProposal['changes'] = [];
  const rejected: string[] = [];

  for (const [fieldName, rawValue] of Object.entries(planned.updates ?? {})) {
    const field = writable.get(fieldName);
    if (!field || fieldPermissions.get(fieldName) !== 'editable') {
      rejected.push(fieldName);
      continue;
    }
    const value = normalizePicklistValue(field, rawValue);
    if (value === undefined) {
      rejected.push(field.label);
      continue;
    }
    if (valuesEqual(record.values[fieldName], value)) continue;
    updates[fieldName] = value;
    changes.push({ field: fieldName, label: field.label, from: record.values[fieldName] ?? null, to: value });
  }

  if (!changes.length) {
    return {
      handled: true,
      answer: rejected.length
        ? `I could not safely map that change to an editable CRM field (${rejected.join(', ')}). Nothing was changed.`
        : `${recordLabel} already has that value, so there is nothing to change.`,
    };
  }

  const preview = planned.summary?.trim().slice(0, 240)
    || `Update ${changes.map((change) => change.label).join(', ')} on ${recordLabel}`;
  const row = await db.queryOne<ActionRow>(
    `INSERT INTO ipy_ai_action
       (user_id, thread_id, action_type, module_name, record_id, payload, preview)
     VALUES ($1,$2,'update_record',$3,$4,$5::jsonb,$6)
     RETURNING *`,
    [ctx.user.id, threadId, moduleName, recordId, JSON.stringify({ updates, changes, recordLabel }), preview],
  );
  if (!row) throw new Error('Could not store assistant action');

  return {
    handled: true,
    answer: `I prepared this CRM change for ${recordLabel}. Please review it below and confirm; nothing has been changed yet.`,
    action: proposalFromRow(row),
  };
}

export async function confirmAssistantAction(
  actionId: string,
  ctx: ServiceContext,
): Promise<{ action: AssistantActionProposal; answer: string; threadId: string }> {
  const result = await transaction(async (conn): Promise<
    { expired: true } | { action: AssistantActionProposal; answer: string; threadId: string }
  > => {
    const row = await conn.queryOne<ActionRow>(
      `SELECT * FROM ipy_ai_action WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [actionId, ctx.user.id],
    );
    if (!row) throw new NotFoundError('Assistant action not found');
    if (row.status !== 'pending') throw new BadRequestError(`This action is already ${row.status}`);
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await conn.query(`UPDATE ipy_ai_action SET status = 'expired' WHERE id = $1`, [row.id]);
      return { expired: true };
    }
    if (!(await canAccessRecord(ctx, row.module_name, row.record_id, 'edit', conn))) {
      throw new ForbiddenError('You no longer have permission to make this change');
    }

    await updateRecord(
      { ...ctx, source: 'ask_ipropy' },
      row.module_name,
      row.record_id,
      row.payload.updates ?? {},
      { conn },
    );
    const updated = await conn.queryOne<ActionRow>(
      `UPDATE ipy_ai_action
       SET status = 'confirmed', confirmed_at = now()
       WHERE id = $1
       RETURNING *`,
      [row.id],
    );
    if (!updated) throw new Error('Could not confirm assistant action');
    return {
      action: proposalFromRow(updated),
      answer: `Done — ${updated.preview}.`,
      threadId: updated.thread_id,
    };
  });
  if ('expired' in result) {
    throw new BadRequestError('This confirmation expired. Ask iPropy to prepare the change again.');
  }
  return result;
}

export async function cancelAssistantAction(
  actionId: string,
  userId: string,
): Promise<{ action: AssistantActionProposal; threadId: string }> {
  const row = await db.queryOne<ActionRow>(
    `UPDATE ipy_ai_action
     SET status = 'cancelled', cancelled_at = now()
     WHERE id = $1 AND user_id = $2 AND status = 'pending'
     RETURNING *`,
    [actionId, userId],
  );
  if (!row) throw new NotFoundError('Pending assistant action not found');
  return { action: proposalFromRow(row), threadId: row.thread_id };
}

export async function actionStatuses(
  actionIds: string[],
  userId: string,
): Promise<Map<string, AssistantActionProposal['status']>> {
  if (!actionIds.length) return new Map();
  await db.query(
    `UPDATE ipy_ai_action
     SET status = 'expired'
     WHERE id = ANY($1::uuid[]) AND user_id = $2 AND status = 'pending' AND expires_at <= now()`,
    [actionIds, userId],
  );
  const rows = await db.query<{ id: string; status: AssistantActionProposal['status']; expires_at: string }>(
    `SELECT id, status, expires_at
     FROM ipy_ai_action
     WHERE id = ANY($1::uuid[]) AND user_id = $2`,
    [actionIds, userId],
  );
  return new Map(rows.rows.map((row) => [row.id, row.status]));
}
