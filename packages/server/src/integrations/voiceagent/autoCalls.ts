/**
 * Automatic daily AI calling (13 November 2026).
 *
 * Three jobs, kept apart so each can be read on its own:
 *   1. `judgeHistory` / `planAutoCalls`: decide WHO would be called, and say why everyone else is left out.
 *      Calls nobody; the Preview button and the real run use the very same function.
 *   2. `startAutoRun`: turn that list into an ordinary batch in the existing queue (`ipy_sarvam_batch`). The queue
 *      is what rings, inside the calling window, re-checking do-not-call at the moment of each call.
 *   3. `tickAutoCalls`: once a minute, start today's run for each module that is switched on, and close runs whose
 *      calling window has ended.
 *
 * Everything ships OFF (migration 239): the master switch and each module switch default to false.
 */
import { db, transaction } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { toE164 } from '@ipropy/shared';
import { isOptedOut } from '../../core/consent/index.js';
import { loadUser } from '../../middleware/auth.js';
import { hasCapability } from '../../core/permissions/index.js';
import { registry } from '../../core/metadata/registry.js';
import { recordService, prepareList } from '../../core/entity/recordService.js';
import { systemContext } from '../../core/workflow/tasks.js';
import { RECORD_ALIAS } from '../../core/query/builder.js';
import { notifyMany } from '../../core/notifications/index.js';
import { isQuietHours } from '../../utils/quietHours.js';
import { readSarvamPolicy, sarvamCallingAllowed } from './policy.js';
import { readSarvamSettings } from './sarvam.js';

export const AI_MODULES = ['leads', 'properties'] as const;
export type AiModule = (typeof AI_MODULES)[number];

export interface Schedule {
  module: string; enabled: boolean; startTime: string; days: number[]; dailyCap: number; viewId: string | null;
  restDays: number; maxAttempts: number; retryHours: number; ownerUserId: string | null;
}

export type SkipReason =
  | 'do_not_call' | 'opted_out' | 'no_phone' | 'duplicate_number' | 'in_flight' | 'called_today' | 'resting'
  | 'max_attempts' | 'retry_not_due' | 'followup_later' | 'recent_human_call' | 'wrong_number';

/** Plain words for each reason, shown on the Preview screen. */
export const SKIP_TEXT: Record<SkipReason, string> = {
  do_not_call: 'Marked do-not-call',
  opted_out: 'Number has opted out of calls',
  no_phone: 'No valid phone number',
  duplicate_number: 'Same number as another record already in this run',
  in_flight: 'Already queued or on a call',
  called_today: 'The AI already called this number today',
  resting: 'Spoke recently; resting before the next call',
  max_attempts: 'Tried the maximum number of times without an answer',
  retry_not_due: 'Tried recently; the next retry is not due yet',
  followup_later: 'A follow-up is already booked for a later day',
  recent_human_call: 'A team member spoke to them in the last 2 days',
  wrong_number: 'Earlier call found it was a wrong number',
};

// ───────────────────────── India-time helpers ─────────────────────────

export function istParts(now: Date): { date: string; time: string; weekday: number } {
  const get = (opts: Intl.DateTimeFormatOptions): string => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', ...opts }).format(now);
  const [dd, mm, yyyy] = get({ day: '2-digit', month: '2-digit', year: 'numeric' }).split('/');
  const dayName = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' }).format(now);
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(dayName) + 1;
  return { date: `${yyyy}-${mm}-${dd}`, time: get({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }), weekday };
}

/** 10:30 India time on the given India date, as a real instant. India has no daylight saving: always +05:30. */
export function istInstant(date: string, hhmm: string): Date {
  return new Date(`${date}T${hhmm}:00+05:30`);
}

// ───────────────────────── Settings ─────────────────────────

const rowToSchedule = (r: Record<string, any>): Schedule => ({
  module: r.module, enabled: r.enabled, startTime: r.start_time, days: (r.days as number[]).map(Number), dailyCap: r.daily_cap,
  viewId: r.view_id, restDays: r.rest_days, maxAttempts: r.max_attempts, retryHours: r.retry_hours, ownerUserId: r.owner_user_id,
});

export async function readSchedules(): Promise<Record<string, Schedule>> {
  const rows = await db.query(`SELECT * FROM ipy_ai_call_schedule`);
  return Object.fromEntries(rows.rows.map((r) => [r.module, rowToSchedule(r)]));
}

// ───────────────────────── Who may be called (pure part) ─────────────────────────

export interface PastCall { at: Date; status: string }
const RETRYABLE = new Set(['no_answer', 'busy', 'voicemail', 'failed']);
const SPOKE = new Set(['answered', 'interested', 'not_interested']);

/**
 * Looks only at how earlier AI calls to this record went. `calls` is newest first, statuses from `ipy_ai_status`.
 * Returns why the record must not be called at `asOf`, or null when its history allows a call.
 */
export function judgeHistory(calls: PastCall[], rule: Pick<Schedule, 'restDays' | 'maxAttempts' | 'retryHours'>, asOf: Date): SkipReason | null {
  const latest = calls[0];
  if (!latest) return null;
  if (latest.status === 'wrong_number') return 'wrong_number';
  if (latest.status === 'do_not_call') return 'do_not_call';
  const day = (d: Date): string => istParts(d).date;
  if (calls.some((c) => day(c.at) === day(asOf))) return 'called_today';
  const dayMs = 86_400_000;
  const lastSpoke = calls.find((c) => SPOKE.has(c.status));
  // "call me back" is not a conversation to rest after: its follow-up date decides when the next call is due.
  if (latest.status !== 'callback' && lastSpoke && asOf.getTime() - lastSpoke.at.getTime() < rule.restDays * dayMs) return 'resting';
  const windowStart = asOf.getTime() - rule.restDays * dayMs;
  const triesSinceTalk = calls.filter((c) => RETRYABLE.has(c.status) && c.at.getTime() > windowStart && (!lastSpoke || c.at > lastSpoke.at)).length;
  if (triesSinceTalk >= rule.maxAttempts) return 'max_attempts';
  if (RETRYABLE.has(latest.status) && asOf.getTime() - latest.at.getTime() < rule.retryHours * 3_600_000) return 'retry_not_due';
  return null;
}

/** The record's first usable phone number, the same way the hand-made queue picks it. */
export function callablePhoneOf(fields: { name: string; uitype: string; isActive: boolean }[], values: Record<string, unknown>): string | null {
  const preferred = ['mobile', 'mobile_phone', 'phone', 'phone_number', 'primary_phone'];
  const rank = (name: string): number => (preferred.includes(name) ? preferred.indexOf(name) : 99);
  return fields.filter((f) => f.isActive && f.uitype === 'phone').sort((a, b) => rank(a.name) - rank(b.name))
    .map((f) => toE164(String(values[f.name] ?? ''))).find(Boolean) ?? null;
}

// ───────────────────────── Planner ─────────────────────────

export interface PlannedCall { recordId: string; label: string; phone: string; why: string }
export interface Skipped { recordId: string; label: string | null; reason: SkipReason }
export interface Plan {
  module: string; asOf: Date; considered: number; capLeft: number; picks: PlannedCall[];
  skippedCount: Partial<Record<SkipReason, number>>; skippedExamples: Skipped[];
  /** Why nothing can be planned at all (no view picked, owner cannot call…). */
  problem: string | null;
}

const CANDIDATE_LIMIT = 2000;

export async function planAutoCalls(input: {
  module: string; asOf: Date; /** hard number of calls to plan, instead of the daily cap */ limit?: number;
  /** Test records picked by hand instead of the saved view. Safety rules still apply, rest/retry rules do not. */ onlyRecordIds?: string[];
}): Promise<Plan> {
  const schedules = await readSchedules();
  const s = schedules[input.module];
  const plan: Plan = { module: input.module, asOf: input.asOf, considered: 0, capLeft: 0, picks: [], skippedCount: {}, skippedExamples: [], problem: null };
  if (!s) { plan.problem = 'This module has no AI calling schedule.'; return plan; }
  const manual = Boolean(input.onlyRecordIds?.length);
  if (!manual && !s.viewId) { plan.problem = 'Pick a saved view that says who may be called. With no view, nobody is called.'; return plan; }

  const today = istParts(input.asOf).date;
  const usedToday = manual || input.limit ? 0 : (await db.queryOne<{ n: number }>(
    `SELECT COALESCE(sum(r.planned),0)::int AS n FROM ipy_ai_call_run r WHERE r.module = $1 AND r.run_date = $2 AND r.trigger = 'schedule'`,
    [input.module, today]))?.n ?? 0;
  plan.capLeft = Math.max(0, (input.limit ?? s.dailyCap) - usedToday);
  if (plan.capLeft === 0) return plan;

  const mod = await registry.requireModule(input.module);
  const sys = await systemContext(null);
  let ids: string[];
  if (manual) ids = input.onlyRecordIds!;
  else {
    const prepared = await prepareList(sys, input.module, { view: s.viewId!, sortBy: 'created_at', sortDir: 'desc' }, db);
    const limitParam = prepared.params.add(CANDIDATE_LIMIT);
    ids = (await db.query<{ id: string }>(`SELECT ${RECORD_ALIAS}.id ${prepared.from} ORDER BY ${prepared.orderBy} LIMIT ${limitParam}`, prepared.params.all())).rows.map((r) => r.id);
  }
  plan.considered = ids.length;
  if (!ids.length) return plan;

  // One query each for everything we need to know about these records.
  const history = new Map<string, PastCall[]>();
  const calls = await db.query<{ record_id: string; started_at: Date; st: string }>(
    `SELECT record_id, started_at, ipy_ai_status(status, disposition, sarvam_meta->>'outcome') AS st FROM ipy_call
      WHERE source = 'sarvam' AND direction = 'outbound' AND record_id = ANY($1::uuid[]) AND started_at > $2::timestamptz - interval '400 days'
      ORDER BY record_id, started_at DESC, id DESC`, [ids, input.asOf]);
  for (const c of calls.rows) (history.get(c.record_id) ?? history.set(c.record_id, []).get(c.record_id)!).push({ at: new Date(c.started_at), status: c.st });

  const inFlight = await db.query<{ record_id: string; phone: string }>(
    `SELECT q.record_id, q.phone FROM ipy_sarvam_queue q JOIN ipy_sarvam_batch b ON b.id = q.batch_id
      WHERE q.status IN ('pending','submitting','waiting','unknown') AND b.status <> 'done'`);
  const busyRecords = new Set(inFlight.rows.map((r) => r.record_id));
  const busyPhones = new Set(inFlight.rows.map((r) => r.phone));

  const calledToday = await db.query<{ n: string }>(
    `SELECT DISTINCT to_number AS n FROM ipy_call WHERE source = 'sarvam' AND direction = 'outbound'
      AND (started_at AT TIME ZONE 'Asia/Kolkata')::date = $1::date`, [today]);
  const phonesCalledToday = new Set(calledToday.rows.map((r) => r.n));

  const humans = new Set((await db.query<{ record_id: string }>(
    `SELECT DISTINCT record_id FROM ipy_call WHERE source <> 'sarvam' AND record_id = ANY($1::uuid[])
        AND started_at > $2::timestamptz - interval '48 hours' AND started_at <= $2::timestamptz`, [ids, input.asOf])).rows.map((r) => r.record_id));

  const followUps = new Map<string, string>();
  const followField = registry.fieldPlaying(mod, 'next_followup_at');
  if (followField?.storage === 'column') {
    const rows = await db.query<{ record_id: string; d: string | null }>(
      `SELECT record_id, to_char(next_followup_at, 'YYYY-MM-DD') AS d FROM ${mod.tableName} WHERE record_id = ANY($1::uuid[])`, [ids]);
    for (const r of rows.rows) if (r.d) followUps.set(r.record_id, r.d);
  }

  const skip = (recordId: string, label: string | null, reason: SkipReason): void => {
    plan.skippedCount[reason] = (plan.skippedCount[reason] ?? 0) + 1;
    if (plan.skippedExamples.length < 150) plan.skippedExamples.push({ recordId, label, reason });
  };

  // Callbacks that were asked for come first, then people never called, then retries.
  const rank = (id: string): number => { const h = history.get(id); return !h?.length ? 1 : h[0]!.status === 'callback' ? 0 : 2; };
  const ordered = manual ? ids : [...ids].sort((a, b) => rank(a) - rank(b));

  const phonesPlanned = new Set<string>();
  for (const id of ordered) {
    if (plan.picks.length >= plan.capLeft) break;
    const past = history.get(id) ?? [];
    if (busyRecords.has(id)) { skip(id, null, 'in_flight'); continue; }
    // A hand-picked test record skips the rest/retry rules (you may want to test the same one twice) but never the safety ones.
    const historyVerdict = judgeHistory(past, s, input.asOf);
    if (historyVerdict && !(manual && historyVerdict !== 'wrong_number' && historyVerdict !== 'do_not_call')) { skip(id, null, historyVerdict); continue; }
    if (!manual) {
      const due = followUps.get(id);
      if (due && due > today) { skip(id, null, 'followup_later'); continue; }
      if (humans.has(id)) { skip(id, null, 'recent_human_call'); continue; }
    }
    let record;
    try { record = await recordService.getRecord(sys, input.module, id); } catch { continue; }
    const label = record.label ?? null;
    if (record.values.do_not_call === true) { skip(id, label, 'do_not_call'); continue; }
    const phone = callablePhoneOf(mod.fields, record.values);
    if (!phone) { skip(id, label, 'no_phone'); continue; }
    if (await isOptedOut(phone, 'call')) { skip(id, label, 'opted_out'); continue; }
    if (phonesPlanned.has(phone) || busyPhones.has(phone)) { skip(id, label, phonesPlanned.has(phone) ? 'duplicate_number' : 'in_flight'); continue; }
    if (!manual && phonesCalledToday.has(phone)) { skip(id, label, 'called_today'); continue; }
    phonesPlanned.add(phone);
    const attempts = past.length;
    plan.picks.push({ recordId: id, label: label ?? phone, phone,
      why: manual ? 'Picked by hand for a test' : past[0]?.status === 'callback' ? 'Asked to be called back' : attempts ? `Retry (attempt ${attempts + 1})` : 'Never called by the AI' });
  }
  return plan;
}

// ───────────────────────── Starting a run ─────────────────────────

/** Can this person's login actually start the queue? Checked before a run so the owner is told in plain words. */
export async function ownerProblem(ownerUserId: string | null): Promise<string | null> {
  if (!ownerUserId) return 'No CRM user is chosen to run the AI queue. Save the schedule once while signed in as an admin.';
  const user = await loadUser(ownerUserId);
  if (!user?.isActive) return 'The CRM user chosen to run the AI queue is inactive.';
  if (!(await hasCapability(user, 'telephony.call'))) return 'The CRM user chosen to run the AI queue may not place calls.';
  return null;
}

export function sarvamProblem(): string | null {
  const read = readSarvamSettings();
  return 'missing' in read ? read.missing : null;
}

async function alertOwners(title: string, body: string, ownerUserId: string | null): Promise<void> {
  const admins = await db.query<{ id: string }>(`SELECT id FROM ipy_user WHERE is_admin AND is_active`);
  await notifyMany([...admins.rows.map((r) => r.id), ...(ownerUserId ? [ownerUserId] : [])], { kind: 'ai_calling', title, body, link: '/admin/ai-calling' })
    .catch((err) => logger.warn({ err }, 'ai-calling: could not notify'));
}

async function audit(module: string, userId: string | null, action: string, details: Record<string, unknown>): Promise<void> {
  await db.query(`INSERT INTO ipy_audit(module_name, user_id, action, changes, source) VALUES ($1,$2,$3,$4::jsonb,'scheduler')`,
    [module, userId, action, JSON.stringify([details])]).catch((err) => logger.warn({ err }, 'ai-calling: audit row failed'));
}

export interface RunResult { runId: string | null; status: string; planned: number; message: string | null }

/**
 * Plan and queue one run. `schedule` runs are once per module per India-time day (the unique index in migration 239
 * makes a second attempt, for instance after a redeploy, find the day already taken). `manual` runs are small tests.
 */
export async function startAutoRun(input: {
  module: string; trigger: 'schedule' | 'manual'; now?: Date; limit?: number; onlyRecordIds?: string[]; startedBy?: string | null;
}): Promise<RunResult> {
  const now = input.now ?? new Date();
  const today = istParts(now).date;
  const schedules = await readSchedules();
  const s = schedules[input.module];
  if (!s) return { runId: null, status: 'failed', planned: 0, message: 'Unknown module.' };

  const claimed = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_ai_call_run(module, run_date, trigger, created_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (module, run_date) WHERE trigger = 'schedule' DO NOTHING RETURNING id`,
    [input.module, today, input.trigger, input.startedBy ?? null]);
  if (!claimed) return { runId: null, status: 'already_ran', planned: 0, message: 'Today\'s run for this module has already started.' };
  const runId = claimed.id;

  const finish = async (status: string, message: string | null, extra: { planned?: number; skipped?: object; batchId?: string } = {}): Promise<RunResult> => {
    await db.query(`UPDATE ipy_ai_call_run SET status=$2, message=$3, planned=$4, skipped=$5::jsonb, batch_id=$6, finished_at = CASE WHEN $2 IN ('running') THEN NULL ELSE now() END WHERE id=$1`,
      [runId, status, message, extra.planned ?? 0, JSON.stringify(extra.skipped ?? {}), extra.batchId ?? null]);
    await audit(input.module, input.startedBy ?? s.ownerUserId, 'ai_calling_run', { runId, trigger: input.trigger, status, planned: extra.planned ?? 0, skipped: extra.skipped ?? {}, message });
    logger.info({ runId, module: input.module, trigger: input.trigger, status, planned: extra.planned ?? 0 }, 'ai-calling: run');
    return { runId, status, planned: extra.planned ?? 0, message };
  };

  try {
    const runAs = input.trigger === 'manual' ? (input.startedBy ?? s.ownerUserId) : s.ownerUserId;
    const problem = sarvamProblem() ?? await ownerProblem(runAs);
    if (problem) { await alertOwners('AI calling could not start', problem, s.ownerUserId); return await finish('failed', problem); }
    const plan = await planAutoCalls({ module: input.module, asOf: now, limit: input.limit, onlyRecordIds: input.onlyRecordIds });
    if (plan.problem) { await alertOwners('AI calling could not start', plan.problem, s.ownerUserId); return await finish('failed', plan.problem); }
    if (!plan.picks.length) return await finish('nothing_to_call', `Nobody to call (looked at ${plan.considered}).`, { skipped: plan.skippedCount });
    const batchId = await transaction(async (tx) => {
      const batch = await tx.queryOne<{ id: string }>(
        `INSERT INTO ipy_sarvam_batch(user_id, module, status, origin, run_id) VALUES ($1,$2,'running','auto',$3) RETURNING id`, [runAs, input.module, runId]);
      for (const [position, pick] of plan.picks.entries()) await tx.query(
        `INSERT INTO ipy_sarvam_queue(batch_id, record_id, label, phone, position) VALUES ($1,$2,$3,$4,$5)`, [batch!.id, pick.recordId, pick.label, pick.phone, position]);
      return batch!.id;
    });
    return await finish('running', null, { planned: plan.picks.length, skipped: plan.skippedCount, batchId });
  } catch (err) {
    logger.error({ err, module: input.module }, 'ai-calling: run failed');
    await alertOwners('AI calling failed', (err as Error).message, s.ownerUserId);
    return finish('failed', (err as Error).message);
  }
}

// ───────────────────────── Why isn't it running? ─────────────────────────

/** One plain sentence per module, so the owner never has to guess why nothing is ringing. */
export function blockedReason(s: Schedule, master: Schedule | undefined, now: Date, policy = readSarvamPolicy()): string | null {
  if (!master?.enabled) return 'The master switch is off.';
  if (!s.enabled) return 'This module\'s switch is off.';
  if (!s.viewId) return 'No saved view is picked, so nobody is eligible.';
  const t = istParts(now);
  if (!s.days.includes(t.weekday)) return 'Today is not one of the chosen days.';
  if (t.time < s.startTime) return `Waiting for the start time (${s.startTime} India time).`;
  if (!sarvamCallingAllowed(policy, now)) return `Outside calling hours (${policy.callStart}–${policy.callEnd} India time).`;
  return null;
}

// ───────────────────────── The once-a-minute tick ─────────────────────────

let ticking = false;
export async function tickAutoCalls(now = new Date()): Promise<void> {
  if (ticking || isQuietHours()) return;
  ticking = true;
  try {
    await closeFinishedRuns(now);
    const schedules = await readSchedules();
    const master = schedules['_master'];
    if (!master?.enabled) return;
    const policy = readSarvamPolicy();
    for (const module of AI_MODULES) {
      const s = schedules[module];
      if (!s || blockedReason(s, master, now, policy)) continue;
      await startAutoRun({ module, trigger: 'schedule', now });
    }
  } catch (err) {
    logger.error({ err }, 'ai-calling: tick failed');
  } finally { ticking = false; }
}

/** The day's run stops cleanly: when the calling window has ended (or the date has changed), nobody left in it is rung. */
export async function closeFinishedRuns(now: Date): Promise<void> {
  const t = istParts(now);
  const policy = readSarvamPolicy();
  const windowOver = policy.callingHoursEnabled === 'true' && policy.callStart < policy.callEnd && t.time >= policy.callEnd;
  const open = await db.query<{ id: string; batch_id: string | null; run_date: string; module: string; created_at: Date; status: string }>(
    `SELECT id, batch_id, to_char(run_date,'YYYY-MM-DD') AS run_date, module, created_at, status FROM ipy_ai_call_run WHERE status IN ('running','planning')`);
  for (const run of open.rows) {
    if (run.status === 'planning') {
      // A run row with no batch after ten minutes means the server stopped mid-plan. Say so; never double up.
      if (Date.now() - new Date(run.created_at).getTime() > 10 * 60_000) {
        await db.query(`UPDATE ipy_ai_call_run SET status='failed', message=$2, finished_at=now() WHERE id=$1`, [run.id, 'The server restarted while planning. Use Run now if you still want these calls.']);
        await alertOwners('AI calling did not start today', 'The server restarted while today\'s run was being prepared.', null);
      }
      continue;
    }
    if (!run.batch_id) continue;
    const batch = await db.queryOne<{ status: string }>(`SELECT status FROM ipy_sarvam_batch WHERE id=$1`, [run.batch_id]);
    if (batch?.status === 'done') {
      await db.query(`UPDATE ipy_ai_call_run SET status='done', finished_at=now() WHERE id=$1`, [run.id]);
      continue;
    }
    const ended = run.run_date < t.date || (run.run_date === t.date && windowOver);
    if (ended) {
      const left = await db.queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM ipy_sarvam_queue WHERE batch_id=$1 AND status='pending'`, [run.batch_id]);
      await db.query(`UPDATE ipy_sarvam_queue SET status='skipped', error='Calling hours ended before this call.', updated_at=now() WHERE batch_id=$1 AND status='pending'`, [run.batch_id]);
      const unresolved = await db.queryOne(`SELECT 1 FROM ipy_sarvam_queue WHERE batch_id=$1 AND status IN ('submitting','waiting','unknown')`, [run.batch_id]);
      await db.query(`UPDATE ipy_sarvam_batch SET status='done', message=NULL WHERE id=$1 AND NOT $2::boolean`, [run.batch_id, Boolean(unresolved)]);
      if (!unresolved) {
        await db.query(`UPDATE ipy_ai_call_run SET status='window_ended', message=$2, finished_at=now() WHERE id=$1`,
          [run.id, left?.n ? `${left.n} calls were not made before calling hours ended.` : null]);
      }
      continue;
    }
    // A batch the queue paused (line limit, unknown outcome, Sarvam refused): tell the owner once.
    const paused = await db.queryOne<{ message: string | null }>(`SELECT message FROM ipy_sarvam_batch WHERE id=$1 AND status='paused'`, [run.batch_id]);
    if (paused) {
      const first = await db.queryOne(`UPDATE ipy_ai_call_run SET alerted_at = now(), message = $2 WHERE id = $1 AND alerted_at IS NULL RETURNING id`, [run.id, paused.message]);
      if (first) await alertOwners('Today\'s AI calls are paused', paused.message ?? 'The queue was paused.', null);
    }
  }
}
