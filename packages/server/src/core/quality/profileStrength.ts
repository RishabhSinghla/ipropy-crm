/**
 * Pushing the team to fill records in — the CRM's half of it.
 *
 * **4 October 2026, the owner:** *"i am pushing my team/agents that, they are
 * fill the form fields maximum, so that the profile strength more stronger, but
 * alls are slacker and they are not trying to do best efforts, so that can you
 * make an option for that they are bound to filled maximum or all the fields in
 * leads/inventory module, or you can pushing hem time to time from crm/system,
 * if the profile strength will good then the client conversation also will be
 * good."*
 *
 * He offered two roads and this takes the second, deliberately.
 *
 * **Making every field mandatory would break the one thing this CRM is fastest
 * at.** A rep on the phone to a buyer types a name and a number and saves; that
 * is how a lead gets in at all rather than on to the back of an envelope. A form
 * that refuses until twenty-five fields are answered is a form nobody uses, and
 * the records would stop arriving rather than arrive fuller. Worse, the
 * automated sources — the website form, the portals, an import — carry what the
 * customer gave and nothing more, so a mandatory field there means the lead is
 * **thrown away**. This repo has lived through exactly that once: migration
 * `026` made two fields stricter and every automated lead failed validation in
 * silence for weeks.
 *
 * So the pressure is applied **after** the record exists, where being wrong
 * costs nothing:
 *
 * * **A target he sets.** `data.min_profile_strength`, Admin → Settings, seeded
 *   `0`, which means off — so the day this ships nothing changes for anybody. He
 *   turns it on at 60 or 75 when he is ready.
 * * **A list.** `profile_strength` is ordinary filter grammar now, so "my
 *   contacts under 60%" is a saved view, a quick filter, a dashboard tile and
 *   the thing counted below — one question asked one way.
 * * **One nudge a day, to the person who can fix it**, naming the count and
 *   linking straight at those records, weakest first. Not one per record: forty
 *   notifications is forty notifications somebody switches off, and then the
 *   useful ones are lost with them. That failure mode is already written down in
 *   this repo.
 *
 * Nothing here blocks a save, and nothing here holds a second opinion about what
 * counts as filled in: the percentage is `strengthPercentExpr`, which is
 * `isAnswerable` in `@ipropy/shared`, which is the bar on the record's own
 * screen. One definition, so a rep chasing 60% and the CRM counting it cannot
 * disagree.
 */
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { registry } from '../metadata/registry.js';
import { notify } from '../notifications/index.js';
import { quoteIdent, RECORD_ALIAS, strengthPercentExpr } from '../query/builder.js';

/** Off. A target nobody chose must not start nagging the team on deploy day. */
const OFF = 0;

export const MIN_STRENGTH_SETTING = 'data.min_profile_strength';

/**
 * The percentage every record is expected to reach, or 0 for "do not chase".
 *
 * Clamped rather than trusted: the row is editable, and a target of 400 would
 * mark every record in the business as thin, every day, for ever. A row holding
 * a word reads as off, the same way the `ui.*` booleans do — a setting that
 * cannot be understood must never make the CRM noisier.
 */
export async function minProfileStrength(): Promise<number> {
  const row = await db.queryOne<{ value: unknown }>(
    `SELECT value FROM ipy_setting WHERE key = $1`, [MIN_STRENGTH_SETTING],
  );
  const target = Math.round(Number(row?.value));
  if (!Number.isFinite(target) || target <= OFF) return OFF;
  return Math.min(100, target);
}

export interface ThinCount {
  module: string;
  moduleLabel: string;
  ownerId: string;
  count: number;
}

/**
 * How many of each person's own records fall short of the target.
 *
 * One query per module, grouped by owner — not one per person, which on a team
 * of twelve would be twelve queries a module for an answer nobody reads on most
 * days. Records with nobody on them are left out: a nudge needs somebody to
 * nudge, and the unassigned queue is a manager's job rather than a rep's.
 */
export async function countThinRecords(target: number): Promise<ThinCount[]> {
  if (target <= OFF) return [];
  const modules = await registry.getModules({ entityOnly: true });
  const out: ThinCount[] = [];
  for (const module of modules) {
    const rows = await db.query<{ owner_id: string; count: number }>(
      `SELECT ${RECORD_ALIAS}.owner_id, COUNT(*)::int AS count
         FROM ipy_record ${RECORD_ALIAS}
         JOIN ${quoteIdent(module.tableName)} ${'e'} ON e.record_id = ${RECORD_ALIAS}.id
        WHERE ${RECORD_ALIAS}.module_id = $1::uuid
          AND ${RECORD_ALIAS}.is_deleted = false
          AND ${RECORD_ALIAS}.owner_id IS NOT NULL
          AND ${RECORD_ALIAS}.owner_type = 'user'
          AND (${strengthPercentExpr(module)}) < $2
        GROUP BY ${RECORD_ALIAS}.owner_id`,
      [module.id, target],
    );
    for (const row of rows.rows) {
      out.push({ module: module.name, moduleLabel: module.label, ownerId: row.owner_id, count: row.count });
    }
  }
  return out;
}

/**
 * The link a nudge carries: that person's own thin records, weakest first.
 *
 * The list already reads `?filter=` as a filter group, so this is the same
 * grammar a saved view holds — no new endpoint and no new screen, and the rep
 * lands somewhere they can sort it, narrow it further and work straight down.
 * `is_me` rather than the id, so the link is the same for everybody and still
 * shows each person only their own.
 */
export function thinRecordsLink(module: string, target: number): string {
  const filter = {
    logic: 'AND',
    conditions: [
      { field: 'profile_strength', operator: 'less_than', value: target },
      { field: 'owner_id', operator: 'is_me' },
    ],
  };
  return `/${module}?filter=${encodeURIComponent(JSON.stringify(filter))}&sort=profile_strength&dir=asc`;
}

/** `9 contacts and 2 inventories of yours are under 60% complete.` */
export function nudgeWording(rows: ThinCount[], target: number): string {
  const parts = rows
    .slice()
    .sort((a, b) => b.count - a.count)
    .map((row) => `${row.count} ${row.moduleLabel.toLowerCase()}`);
  if (!parts.length) return '';
  const list = parts.length > 1
    ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
    : parts[0]!;
  const one = rows.length === 1 && rows[0]!.count === 1;
  return `${list} of yours ${one ? 'is' : 'are'} under ${target}% complete.`;
}

let lastRunDay = '';

/**
 * Once a day, if a target has been set.
 *
 * Keyed on the calendar day rather than on hours elapsed, so a restart at 09:01
 * cannot send everybody a second copy and the first tick after a restart still
 * sends it rather than waiting out a timer that was reset. The same rule the
 * morning brief follows, for the same reason.
 *
 * Between nine and eleven: before nine nobody reads it, and after lunch it is a
 * list of yesterday's work.
 */
export async function nudgeThinRecords(now = new Date()): Promise<{ sent: number }> {
  const target = await minProfileStrength();
  if (target <= OFF) return { sent: 0 };

  const today = now.toDateString();
  if (lastRunDay === today) return { sent: 0 };
  if (now.getHours() < 9 || now.getHours() >= 11) return { sent: 0 };
  lastRunDay = today;

  const rows = await countThinRecords(target);
  const byOwner = new Map<string, ThinCount[]>();
  for (const row of rows) {
    const list = byOwner.get(row.ownerId) ?? [];
    list.push(row);
    byOwner.set(row.ownerId, list);
  }

  let sent = 0;
  for (const [ownerId, theirs] of byOwner) {
    const biggest = theirs.slice().sort((a, b) => b.count - a.count)[0]!;
    await notify({
      userId: ownerId,
      kind: 'reminder',
      title: 'Some of your records need filling in',
      body: `${nudgeWording(theirs, target)} A fuller record is a better conversation — open the list and finish the ones you already know.`,
      link: thinRecordsLink(biggest.module, target),
    });
    sent += 1;
  }
  if (sent) logger.info({ sent, target }, 'profile strength nudges sent');
  return { sent };
}

/** Tests reach for this, so one suite's run cannot stop the next one's. */
export function resetNudgeDay(): void {
  lastRunDay = '';
}
