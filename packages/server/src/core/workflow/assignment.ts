/**
 * Lead assignment / routing.
 *
 * Rules are evaluated in sequence; the first whose conditions match wins.
 * Strategies balance for real-world sales-floor behaviour: round-robin for
 * fairness, load-balanced for capacity, least-busy for responsiveness.
 */
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { evaluateFilter } from '../query/evaluate.js';

export interface AssignOptions {
  strategy?: string;
  userIds?: string[];
  groupId?: string;
}

interface RuleRow {
  id: string;
  name: string;
  conditions: never;
  strategy: string;
  target_users: string[];
  target_group_id: string | null;
  cursor_index: number;
  respect_capacity: boolean;
  working_hours_only: boolean;
}

export async function assignOwner(
  moduleName: string,
  record: Record<string, unknown>,
  opts: AssignOptions = {},
): Promise<string | null> {
  // Explicit strategy from a workflow task bypasses the rule table.
  if (opts.strategy && opts.strategy !== 'rules') {
    const pool = opts.groupId
      ? await groupMembers(opts.groupId)
      : opts.userIds ?? [];
    return pickFromPool(pool, opts.strategy, moduleName);
  }

  const rules = await db.query<RuleRow>(
    `SELECT ar.id, ar.name, ar.conditions, ar.strategy, ar.target_users, ar.target_group_id,
            ar.cursor_index, ar.respect_capacity, ar.working_hours_only
     FROM ipy_assignment_rule ar JOIN ipy_module m ON m.id = ar.module_id
     WHERE m.name = $1 AND ar.is_active ORDER BY ar.sequence`,
    [moduleName],
  );

  for (const rule of rules.rows) {
    if (!evaluateFilter(rule.conditions, record)) continue;

    let pool = rule.target_group_id
      ? await groupMembers(rule.target_group_id)
      : (rule.target_users ?? []);

    if (!pool.length) continue;

    pool = await filterEligible(pool, {
      respectCapacity: rule.respect_capacity,
      workingHoursOnly: rule.working_hours_only,
      moduleName,
    });
    if (!pool.length) {
      logger.warn({ rule: rule.name }, 'assignment rule matched but no eligible user was available');
      continue;
    }

    const chosen = await pickFromPool(pool, rule.strategy, moduleName, rule);
    if (chosen) {
      logger.debug({ rule: rule.name, chosen }, 'lead assigned');
      return chosen;
    }
  }

  return null;
}

async function groupMembers(groupId: string): Promise<string[]> {
  const direct = await db.query<{ member_id: string; member_type: string }>(
    `SELECT member_id, member_type FROM ipy_group_member WHERE group_id = $1`, [groupId],
  );
  const users: string[] = [];
  for (const m of direct.rows) {
    if (m.member_type === 'user') {
      users.push(m.member_id);
    } else if (m.member_type === 'role' || m.member_type === 'role_subordinates') {
      const res = await db.query<{ id: string }>(
        m.member_type === 'role'
          ? `SELECT id FROM ipy_user WHERE role_id = $1 AND deleted_at IS NULL`
          : `SELECT u.id FROM ipy_user u JOIN ipy_role r ON r.id = u.role_id
             WHERE (r.id = $1 OR $1 = ANY(r.path)) AND u.deleted_at IS NULL`,
        [m.member_id],
      );
      users.push(...res.rows.map((r) => r.id));
    }
  }
  return [...new Set(users)];
}

interface EligibilityOptions {
  respectCapacity: boolean;
  workingHoursOnly: boolean;
  moduleName: string;
}

/** Filter out inactive users, opted-out users, and anyone over their daily cap. */
async function filterEligible(pool: string[], opts: EligibilityOptions): Promise<string[]> {
  if (!pool.length) return [];
  const rows = await db.query<{ id: string; accepts_leads: boolean; daily_lead_cap: number | null; today_count: number }>(
    `SELECT u.id, u.accepts_leads, u.daily_lead_cap,
            (SELECT COUNT(*)::int FROM ipy_record r
             JOIN ipy_module m ON m.id = r.module_id
             WHERE r.owner_id = u.id AND m.name = $2
               AND r.created_at >= date_trunc('day', now())) AS today_count
     FROM ipy_user u
     WHERE u.id = ANY($1::uuid[]) AND u.is_active = true AND u.deleted_at IS NULL`,
    [pool, opts.moduleName],
  );

  return rows.rows
    .filter((u) => u.accepts_leads)
    .filter((u) => !opts.respectCapacity || !u.daily_lead_cap || u.today_count < u.daily_lead_cap)
    .map((u) => u.id);
}

async function pickFromPool(
  pool: string[],
  strategy: string,
  moduleName: string,
  rule?: RuleRow,
): Promise<string | null> {
  if (!pool.length) return null;

  switch (strategy) {
    case 'specific_user':
      return pool[0];

    case 'round_robin': {
      if (!rule) return pool[Math.floor(Math.random() * pool.length)];
      // Advance the cursor atomically so two concurrent leads don't collide.
      const updated = await db.queryOne<{ cursor_index: number }>(
        `UPDATE ipy_assignment_rule SET cursor_index = cursor_index + 1 WHERE id = $1 RETURNING cursor_index`,
        [rule.id],
      );
      const idx = (updated?.cursor_index ?? 0) % pool.length;
      return pool[idx];
    }

    case 'load_balanced': {
      // Fewest open records wins — keeps workloads even over time.
      const counts = await db.query<{ owner_id: string; count: number }>(
        `SELECT r.owner_id, COUNT(*)::int AS count
         FROM ipy_record r JOIN ipy_module m ON m.id = r.module_id
         WHERE r.owner_id = ANY($1::uuid[]) AND m.name = $2 AND r.is_deleted = false
         GROUP BY 1`,
        [pool, moduleName],
      );
      const byUser = new Map(counts.rows.map((c) => [c.owner_id, c.count]));
      return pool.slice().sort((a, b) => (byUser.get(a) ?? 0) - (byUser.get(b) ?? 0))[0];
    }

    case 'least_busy': {
      // Fewest follow-ups already due — "who can call right now". Reads the
      // lead's own next-follow-up date now that Activities is gone; same
      // question, one table fewer.
      const counts = await db.query<{ owner_id: string; count: number }>(
        `SELECT r.owner_id, COUNT(*)::int AS count
         FROM ipy_e_leads l
         JOIN ipy_record r ON r.id = l.record_id
         WHERE r.owner_id = ANY($1::uuid[]) AND r.is_deleted = false
           AND l.next_followup_at IS NOT NULL AND l.next_followup_at <= CURRENT_DATE
         GROUP BY 1`,
        [pool],
      );
      const byUser = new Map(counts.rows.map((c) => [c.owner_id, c.count]));
      return pool.slice().sort((a, b) => (byUser.get(a) ?? 0) - (byUser.get(b) ?? 0))[0];
    }

    case 'group':
      return rule?.target_group_id ?? pool[0];

    case 'ai_best_fit':
      // Falls back to load balancing until the AI matcher is configured;
      // see ai/routing.ts for the scored variant.
      return pickFromPool(pool, 'load_balanced', moduleName, rule);

    default:
      return pool[0];
  }
}

/** Round-robin over an explicit user list — used by webforms. */
export async function nextInRotation(ruleId: string, pool: string[]): Promise<string | null> {
  if (!pool.length) return null;
  const updated = await db.queryOne<{ cursor_index: number }>(
    `UPDATE ipy_assignment_rule SET cursor_index = cursor_index + 1 WHERE id = $1 RETURNING cursor_index`,
    [ruleId],
  );
  return pool[(updated?.cursor_index ?? 0) % pool.length];
}
