import { z } from 'zod';
import { db, transaction } from '../../db/pool.js';
import { getModule } from '../../core/metadata/registry.js';
import { BadRequestError } from '../../utils/errors.js';

export const facebookAssignmentInput = z.object({
  strategy: z.enum(['specific_user', 'round_robin']),
  userIds: z.array(z.string().uuid()).min(1).max(100),
}).superRefine((value, ctx) => {
  if (value.strategy === 'specific_user' && value.userIds.length !== 1) {
    ctx.addIssue({ code: 'custom', message: 'Choose exactly one agent for single-agent assignment.' });
  }
  if (new Set(value.userIds).size !== value.userIds.length) {
    ctx.addIssue({ code: 'custom', message: 'Choose each agent only once.' });
  }
});

export async function getFacebookAssignment() {
  return db.queryOne<{ id: string; strategy: string; userIds: string[] }>(
    `SELECT ar.id, ar.strategy, ar.target_users AS "userIds" FROM ipy_facebook_health h
     JOIN ipy_assignment_rule ar ON ar.id = h.assignment_rule_id WHERE h.id = true`);
}

export async function saveFacebookAssignment(input: z.infer<typeof facebookAssignmentInput>, actorId: string) {
  const meta = await getModule('leads');
  const source = meta?.fields.find((f) => ['source', 'lead_source'].includes(f.name) && f.isActive);
  const option = source?.options?.find((o) => [o.value, o.label].some((v) => /^facebook(?: lead ads?)?$/i.test(v.trim())));
  if (!meta || !source || !option) throw new BadRequestError('Add an active Facebook Source option first.');
  await transaction(async (tx) => {
    await tx.query('SELECT id FROM ipy_facebook_health WHERE id = true FOR UPDATE');
    const users = await tx.query<{ id: string }>(
      `SELECT id FROM ipy_user WHERE id = ANY($1::uuid[]) AND is_active AND accepts_leads
       AND deleted_at IS NULL FOR SHARE`, [input.userIds]);
    if (users.rows.length !== input.userIds.length) throw new BadRequestError('Every selected agent must be active and accept leads.');
    const before = await tx.queryOne<{ assignment_rule_id: string | null }>(
      'SELECT assignment_rule_id FROM ipy_facebook_health WHERE id = true');
    const conditions = JSON.stringify({ logic: 'AND', conditions: [{ field: source.name, operator: 'equals', value: option.value }] });
    let ruleId = before?.assignment_rule_id;
    if (ruleId) {
      await tx.query(`UPDATE ipy_assignment_rule SET strategy = $2, target_users = $3,
        conditions = $4, is_active = true, respect_capacity = false, working_hours_only = false,
        target_group_id = NULL WHERE id = $1`, [ruleId, input.strategy, JSON.stringify(input.userIds), conditions]);
    } else {
      const rule = await tx.queryOne<{ id: string }>(`INSERT INTO ipy_assignment_rule
        (module_id, name, strategy, target_users, conditions, sequence, respect_capacity, cursor_index)
        VALUES ($1, 'Facebook lead assignment', $2, $3, $4, -100, false, -1) RETURNING id`,
      [meta.id, input.strategy, JSON.stringify(input.userIds), conditions]);
      ruleId = rule!.id;
      await tx.query('UPDATE ipy_facebook_health SET assignment_rule_id = $1 WHERE id = true', [ruleId]);
    }
    await tx.query(`INSERT INTO ipy_audit (module_name, user_id, action, changes, source)
      VALUES ('leads', $1, 'facebook_assignment_updated', $2, 'admin')`,
    [actorId, JSON.stringify([{ field: 'facebook_assignment', old: before, new: input }])]);
  });
  return getFacebookAssignment();
}
