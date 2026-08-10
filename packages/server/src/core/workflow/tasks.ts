/**
 * Workflow task implementations.
 *
 * Each task type is a small function over (config, context). Adding a new
 * automation capability means adding one entry to TASK_HANDLERS — the engine,
 * the queue and the admin UI pick it up without further changes.
 */
import type { AuthUser } from '@ipropy/shared';
import { renderTemplate, toE164, toInternational } from '@ipropy/shared';
import { db, type Tx } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { registry } from '../metadata/registry.js';
import { withNameParts } from '../entity/nameParts.js';
import { formatValue } from '../metadata/values.js';
import { createRecord, updateRecord, type ServiceContext } from '../entity/recordService.js';
import { assignOwner } from './assignment.js';
import { scheduleFollowUp } from './followUp.js';

export interface TaskContext {
  workflowId: string;
  taskId: string;
  module: string;
  recordId: string;
  record: Record<string, unknown>;
  previous?: Record<string, unknown>;
  user: AuthUser | null;
  source: string;
}

type TaskHandler = (config: Record<string, unknown>, ctx: TaskContext) => Promise<void>;

/**
 * A system actor so tasks can write records without a signed-in user. Its
 * ServiceContext is marked `system`, which bypasses permission checks — this is
 * the only place that happens outside integrations.
 */
export async function systemContext(user: AuthUser | null): Promise<ServiceContext> {
  const actor: AuthUser = user ?? {
    id: '00000000-0000-0000-0000-000000000000',
    email: 'system@ipropy', firstName: 'iPropy', lastName: 'Automation',
    fullName: 'iPropy Automation', avatarUrl: null, phone: null,
    isAdmin: true, isActive: true, roleId: null, roleName: null,
    profileId: null, profileName: null, groupIds: [],
    timezone: 'Asia/Kolkata', locale: 'en-IN', currency: 'INR',
    theme: 'system', defaultDashboardId: null, extension: null, lastLoginAt: null,
  };
  return { user: actor, subordinateIds: [], groupIds: [], system: true, source: 'workflow' };
}

/**
 * Build the merge bag templates resolve against:
 *   {{field}}          → record value (formatted)
 *   {{field__display}} → resolved label of a lookup
 *   {{owner.*}}, {{org.*}}, {{now}}
 */
async function buildMergeScope(ctx: TaskContext): Promise<Record<string, unknown>> {
  const module = await registry.getModule(ctx.module);
  // `{{first_name}}` appears in most seeded templates and is now derived from
  // `full_name` rather than stored — see core/entity/nameParts.ts.
  const scope: Record<string, unknown> = withNameParts({ ...ctx.record });

  if (module) {
    for (const f of module.fields) {
      const v = ctx.record[f.name];
      if (v === null || v === undefined || v === '') continue;
      scope[f.name] = formatValue(f, v);
      if (f.uitype === 'reference') {
        const label = await db.queryOne<{ label: string }>(`SELECT label FROM ipy_record WHERE id = $1`, [v]);
        scope[`${f.name}__display`] = label?.label ?? '';
      }
    }
  }

  const ownerId = ctx.record.owner_id as string | undefined;
  if (ownerId) {
    const owner = await db.queryOne<{ first_name: string; last_name: string; email: string; phone: string | null }>(
      `SELECT first_name, last_name, email, phone FROM ipy_user WHERE id = $1`, [ownerId],
    );
    if (owner) {
      scope.owner = {
        first_name: owner.first_name,
        last_name: owner.last_name,
        full_name: `${owner.first_name} ${owner.last_name}`.trim(),
        email: owner.email,
        phone: owner.phone ?? '',
      };
      scope.owner_name = `${owner.first_name} ${owner.last_name}`.trim();
    }
  }

  const orgName = await db.queryOne<{ value: string }>(`SELECT value #>> '{}' AS value FROM ipy_setting WHERE key = 'org.name'`);
  scope.org = { name: orgName?.value ?? 'iPropy' };
  scope.now = new Date().toISOString();
  scope.today = new Date().toISOString().slice(0, 10);
  scope.record_label = ctx.record.__label ?? '';
  scope.record_id = ctx.recordId;

  return scope;
}

function render(template: string | undefined, scope: Record<string, unknown>): string {
  if (!template) return '';
  return renderTemplate(template, scope);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const updateFields: TaskHandler = async (config, ctx) => {
  const svc = await systemContext(ctx.user);
  const scope = await buildMergeScope(ctx);

  let targetModule = ctx.module;
  let targetId = ctx.recordId;

  // A task can act on a related record ("block the unit on this deal").
  if (config.targetRecord && config.targetModule) {
    const refId = ctx.record[String(config.targetRecord)];
    if (!refId) return;
    targetId = String(refId);
    targetModule = String(config.targetModule);
  }

  const values: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries((config.values ?? {}) as Record<string, unknown>)) {
    values[key] = typeof raw === 'string' && raw.includes('{{') ? render(raw, scope) : raw;
  }

  // Numeric bumps (reminder_count + 1) need the current value, not a literal.
  for (const [key, delta] of Object.entries((config.incrementFields ?? {}) as Record<string, number>)) {
    const current = Number(ctx.record[key] ?? 0);
    values[key] = current + Number(delta);
  }

  // Convenience for inventory holds.
  if (config.setBlockedUntilDays) {
    values.blocked_until = new Date(Date.now() + Number(config.setBlockedUntilDays) * 86_400_000).toISOString();
  }

  // Lifecycle promotion only ever moves forward, so a fresh enquiry from an
  // existing customer can't demote them back to a lead.
  if (config.advanceLifecycle) {
    const { advanceLifecycle } = await import('../entity/conversion.js');
    await advanceLifecycle(svc, targetId, config.advanceLifecycle as 'Prospect' | 'Customer');
    if (!Object.keys(values).length) return;
  }

  // Keep deal probability/win-loss in step with the stage picklist.
  if (config.applyStageMeta) {
    const module = await registry.getModule(targetModule);
    const stageField = module?.pipelineField;
    if (stageField) {
      const stageValue = ctx.record[stageField];
      const meta = await db.queryOne<{ meta: { probability?: number; isWon?: boolean; isLost?: boolean } }>(
        `SELECT v.meta FROM ipy_picklist_value v
         JOIN ipy_picklist p ON p.id = v.picklist_id
         JOIN ipy_field f ON f.config->>'picklist' = p.name
         WHERE f.module_id = $1 AND f.name = $2 AND v.value = $3`,
        [module!.id, stageField, stageValue],
      );
      if (meta?.meta) {
        if (meta.meta.probability !== undefined) values.probability = meta.meta.probability;
        if (meta.meta.isWon !== undefined) values.is_won = meta.meta.isWon;
        if (meta.meta.isLost !== undefined) values.is_lost = meta.meta.isLost;
        if (meta.meta.isWon) values.actual_close_date = new Date().toISOString().slice(0, 10);
      }
      values.stage_changed_at = new Date().toISOString();
      values.days_in_stage = 0;
    }
  }

  if (!Object.keys(values).length) return;
  // skipWorkflow prevents a field-update task from re-triggering its own workflow.
  await updateRecord(svc, targetModule, targetId, values, { skipWorkflow: true });
};

const createRecordTask: TaskHandler = async (config, ctx) => {
  const svc = await systemContext(ctx.user);
  const scope = await buildMergeScope(ctx);

  const targetModule = String(config.module ?? '');
  if (!targetModule) return;

  const values: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries((config.values ?? {}) as Record<string, unknown>)) {
    values[key] = typeof raw === 'string' ? render(raw, scope) : raw;
  }
  if (config.linkField) values[String(config.linkField)] = ctx.recordId;
  if (!values.owner_id) values.owner_id = ctx.record.owner_id;

  await createRecord(svc, targetModule, values, { skipDuplicateCheck: true });
};

/**
 * Schedule a follow-up.
 *
 * Was "create an Activity record". With that module gone the action writes the
 * due date onto the record itself, notes the reason on its timeline and pings
 * the owner — see core/workflow/followUp.ts. Existing workflow configurations
 * keep working: `subject`, `description` and `dueInMinutes` mean what they
 * always did.
 */
const createTaskAction: TaskHandler = async (config, ctx) => {
  const scope = await buildMergeScope(ctx);
  const dueMinutes = Number(config.dueInMinutes ?? 60);

  let ownerId = ctx.record.owner_id as string | null;
  if (config.assignTo && config.assignTo !== 'record_owner') {
    ownerId = await resolvePrincipal(String(config.assignTo), ctx);
  }

  await scheduleFollowUp({
    recordId: ctx.recordId,
    module: ctx.module,
    on: new Date(Date.now() + dueMinutes * 60_000),
    reason: render(String(config.subject ?? 'Follow up'), scope),
    notes: config.description ? render(String(config.description), scope) : null,
    ownerId,
    authorId: ownerId,
  });
};

const assignOwnerTask: TaskHandler = async (config, ctx) => {
  const ownerId = await assignOwner(ctx.module, ctx.record, {
    strategy: String(config.strategy ?? 'rules'),
    userIds: (config.userIds as string[]) ?? undefined,
    groupId: config.groupId ? String(config.groupId) : undefined,
  });
  if (!ownerId) return;
  const svc = await systemContext(ctx.user);
  await updateRecord(svc, ctx.module, ctx.recordId, { owner_id: ownerId }, { skipWorkflow: true });
};

const notifyUser: TaskHandler = async (config, ctx) => {
  const { notifyMany } = await import('../notifications/index.js');
  const scope = await buildMergeScope(ctx);
  const recipients = await resolveRecipients(String(config.to ?? 'record_owner'), ctx);

  // Goes through notify() rather than a raw INSERT so the same message also
  // reaches the recipient's phone — a lead assigned at 9pm is worth nothing if
  // it waits for someone to open the CRM in the morning.
  await notifyMany(recipients, {
    kind: String(config.kind ?? 'workflow'),
    title: render(String(config.title ?? 'Workflow notification'), scope),
    body: render(String(config.body ?? ''), scope),
    link: `/${ctx.module}/${ctx.recordId}`,
    recordId: ctx.recordId,
  });
};

const sendWhatsApp: TaskHandler = async (config, ctx) => {
  const { sendWhatsAppForWorkflow } = await import('../../integrations/whatsapp/service.js');
  const scope = await buildMergeScope(ctx);

  if (config.skipIf) {
    const { evaluateFilter } = await import('@ipropy/shared');
    if (evaluateFilter(config.skipIf as never, ctx.record)) return;
  }

  const to = await resolvePhone(String(config.to ?? '{{mobile}}'), ctx, scope);
  if (!to) {
    logger.debug({ recordId: ctx.recordId }, 'whatsapp task skipped — no phone number');
    return;
  }

  await sendWhatsAppForWorkflow({
    to,
    templateName: config.template ? String(config.template) : undefined,
    fallbackText: config.fallbackText ? render(String(config.fallbackText), scope) : undefined,
    useAiDraft: Boolean(config.useAiDraft),
    recordId: ctx.recordId,
    module: ctx.module,
    scope,
    workflowId: ctx.workflowId,
  });
};

const sendEmail: TaskHandler = async (config, ctx) => {
  const { sendTemplatedEmail } = await import('../../integrations/email/service.js');
  const scope = await buildMergeScope(ctx);
  const to = await resolveEmail(String(config.to ?? '{{email}}'), ctx, scope);
  if (!to) return;

  await sendTemplatedEmail({
    to,
    templateName: config.template ? String(config.template) : undefined,
    subject: config.subject ? render(String(config.subject), scope) : undefined,
    html: config.html ? render(String(config.html), scope) : undefined,
    recordId: ctx.recordId,
    scope,
  });
};

const sendSms: TaskHandler = async (config, ctx) => {
  const scope = await buildMergeScope(ctx);
  const to = await resolvePhone(String(config.to ?? '{{mobile}}'), ctx, scope);
  if (!to) return;
  logger.info({ to, recordId: ctx.recordId }, 'SMS task — configure an SMS provider to deliver');
};

const webhook: TaskHandler = async (config, ctx) => {
  const url = String(config.url ?? '');
  if (!url) return;
  const scope = await buildMergeScope(ctx);
  const payload = {
    event: 'workflow.task',
    module: ctx.module,
    recordId: ctx.recordId,
    workflowId: ctx.workflowId,
    record: ctx.record,
    triggeredAt: new Date().toISOString(),
    ...(config.payload ? JSON.parse(render(JSON.stringify(config.payload), scope)) : {}),
  };
  try {
    const res = await fetch(url, {
      method: String(config.method ?? 'POST'),
      headers: { 'Content-Type': 'application/json', ...(config.headers as Record<string, string> ?? {}) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    logger.info({ url, status: res.status }, 'workflow webhook delivered');
  } catch (err) {
    logger.error({ err, url }, 'workflow webhook failed');
    throw err;
  }
};

const addTag: TaskHandler = async (config, ctx) => {
  const tags = (config.tags as string[]) ?? [];
  for (const name of tags) {
    const tag = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_tag (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [name.toLowerCase()],
    );
    if (tag) {
      await db.query(`INSERT INTO ipy_tag_link (tag_id, record_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [
        tag.id, ctx.recordId,
      ]);
    }
  }
};

const aiAction: TaskHandler = async (config, ctx) => {
  const { runAiWorkflowAction } = await import('../../ai/actions.js');
  await runAiWorkflowAction(String(config.action ?? ''), config, ctx);
};

const triggerCall: TaskHandler = async (config, ctx) => {
  const { placeCall } = await import('../../integrations/telephony/service.js');
  const scope = await buildMergeScope(ctx);
  const to = await resolvePhone(String(config.to ?? '{{mobile}}'), ctx, scope);
  const agentId = ctx.record.owner_id as string | null;
  if (!to || !agentId) return;
  await placeCall({ agentUserId: agentId, toNumber: to, recordId: ctx.recordId, module: ctx.module });
};

const delay: TaskHandler = async () => {
  // Delay is expressed via delay_minutes on the task row; nothing to do here.
};


const TASK_HANDLERS: Record<string, TaskHandler> = {
  update_fields: updateFields,
  create_record: createRecordTask,
  create_task: createTaskAction,
  create_event: createTaskAction,
  assign_owner: assignOwnerTask,
  notify_user: notifyUser,
  send_whatsapp: sendWhatsApp,
  send_email: sendEmail,
  send_sms: sendSms,
  webhook,
  add_tag: addTag,
  ai_action: aiAction,
  trigger_call: triggerCall,
  delay,
};

export async function runTask(
  type: string,
  config: Record<string, unknown>,
  ctx: TaskContext,
): Promise<void> {
  const handler = TASK_HANDLERS[type];
  if (!handler) {
    logger.warn({ type }, 'unknown workflow task type');
    return;
  }
  await handler(config, ctx);
}

export const TASK_TYPES = Object.keys(TASK_HANDLERS);

// ---------------------------------------------------------------------------
// Recipient / value resolution
// ---------------------------------------------------------------------------

async function resolvePrincipal(spec: string, ctx: TaskContext): Promise<string | null> {
  if (spec === 'record_owner') return (ctx.record.owner_id as string) ?? null;
  if (spec === 'record_creator') return (ctx.record.created_by as string) ?? null;
  if (spec.startsWith('user:')) return spec.slice(5);
  if (spec.startsWith('group:')) {
    const group = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_group WHERE name = $1`, [spec.slice(6)]);
    return group?.id ?? null;
  }
  return spec;
}

async function resolveRecipients(spec: string, ctx: TaskContext): Promise<string[]> {
  if (spec === 'record_owner') {
    const ownerId = ctx.record.owner_id as string | null;
    if (!ownerId) return [];
    // The owner may be a group, in which case notify every member.
    const isGroup = await db.queryOne(`SELECT 1 FROM ipy_group WHERE id = $1`, [ownerId]);
    if (!isGroup) return [ownerId];
    const members = await db.query<{ member_id: string }>(
      `SELECT member_id FROM ipy_group_member WHERE group_id = $1 AND member_type = 'user'`, [ownerId],
    );
    return members.rows.map((m) => m.member_id);
  }

  if (spec === 'owner_manager') {
    const ownerId = ctx.record.owner_id as string | null;
    if (!ownerId) return [];
    const manager = await db.queryOne<{ manager_id: string | null }>(
      `SELECT COALESCE(u.reports_to, (
         SELECT m.id FROM ipy_user m
         JOIN ipy_role mr ON mr.id = m.role_id
         JOIN ipy_role ur ON ur.id = u.role_id
         WHERE mr.id = ur.parent_id AND m.deleted_at IS NULL LIMIT 1
       )) AS manager_id
       FROM ipy_user u WHERE u.id = $1`,
      [ownerId],
    );
    return manager?.manager_id ? [manager.manager_id] : [];
  }

  if (spec.startsWith('group:')) {
    const members = await db.query<{ member_id: string }>(
      `SELECT gm.member_id FROM ipy_group_member gm
       JOIN ipy_group g ON g.id = gm.group_id
       WHERE g.name = $1 AND gm.member_type = 'user'`,
      [spec.slice(6)],
    );
    return members.rows.map((m) => m.member_id);
  }

  if (spec.startsWith('role:')) {
    const users = await db.query<{ id: string }>(
      `SELECT u.id FROM ipy_user u JOIN ipy_role r ON r.id = u.role_id
       WHERE r.name = $1 AND u.deleted_at IS NULL`,
      [spec.slice(5)],
    );
    return users.rows.map((u) => u.id);
  }

  if (spec.startsWith('user:')) return [spec.slice(5)];
  return [spec];
}

/** Resolve a phone spec: a merge tag, a field name, or a related contact. */
async function resolvePhone(
  spec: string,
  ctx: TaskContext,
  scope: Record<string, unknown>,
): Promise<string | null> {
  if (spec === 'related_contact_mobile') {
    for (const key of ['contact_id', 'lead_id', 'related_to']) {
      const refId = ctx.record[key];
      if (!refId) continue;
      const phone = await db.queryOne<{ mobile: string | null; country_code: string | null }>(
        `SELECT COALESCE(l.whatsapp_number, l.mobile) AS mobile, l.country_code
           FROM ipy_e_leads l WHERE l.record_id = $1`,
        [refId],
      );
      if (phone?.mobile) return toInternational(phone.country_code, phone.mobile);
    }
    // Fall back to the record's own number.
    const own = ctx.record.whatsapp_number ?? ctx.record.mobile;
    return own ? toInternational(String(ctx.record.country_code ?? ''), String(own)) : null;
  }

  const rendered = spec.includes('{{') ? render(spec, scope) : (ctx.record[spec] ? String(ctx.record[spec]) : spec);
  return rendered ? toE164(rendered) : null;
}

async function resolveEmail(
  spec: string,
  ctx: TaskContext,
  scope: Record<string, unknown>,
): Promise<string | null> {
  if (spec === 'related_contact_email') {
    for (const key of ['contact_id', 'lead_id', 'related_to']) {
      const refId = ctx.record[key];
      if (!refId) continue;
      const row = await db.queryOne<{ email: string | null }>(
        `SELECT l.email FROM ipy_e_leads l WHERE l.record_id = $1`,
        [refId],
      );
      if (row?.email) return row.email;
    }
    return ctx.record.email ? String(ctx.record.email) : null;
  }
  const rendered = spec.includes('{{') ? render(spec, scope) : (ctx.record[spec] ? String(ctx.record[spec]) : spec);
  return rendered && rendered.includes('@') ? rendered : null;
}

// ---------------------------------------------------------------------------
// Payment schedule generation
// ---------------------------------------------------------------------------

const DEFAULT_MILESTONES = [
  { milestone: 'On Booking', percent: 10, offsetDays: 0 },
  { milestone: 'On Agreement', percent: 20, offsetDays: 30 },
  { milestone: 'On Plinth Completion', percent: 15, offsetDays: 120 },
  { milestone: 'On 5th Slab', percent: 15, offsetDays: 210 },
  { milestone: 'On 10th Slab', percent: 15, offsetDays: 300 },
  { milestone: 'On Brickwork', percent: 10, offsetDays: 390 },
  { milestone: 'On Possession', percent: 15, offsetDays: 480 },
];
