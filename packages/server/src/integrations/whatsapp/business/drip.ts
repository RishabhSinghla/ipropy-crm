/**
 * The slow promotional drip on the linked WhatsApp numbers.
 *
 * The CRM has no "send to many" button on OpenWA, on purpose (docs/OPENWA.md). This is the one exception, built so it
 * cannot become one by accident:
 *
 *  - **It is not an endpoint that sends.** An admin creates a queue, is shown how many people it is, and presses
 *    Start. After that a background clock sends *one* message per tick-with-a-gap, and every one of them goes through
 *    `sendOnBusinessNumber` — the same single send path every other message uses, with every per-recipient check
 *    (opt-out, number ready and not paused, spacing, quiet hours, a record to talk about) still in force.
 *  - **Slow by construction.** A cap per number per day that starts low and ramps; a random gap of a minute or two;
 *    daytime only (`dripRules.ts` holds the numbers, with a ceiling in code no setting can lift).
 *  - **Everything is frozen at Start.** The people are copied into `ipy_wa_drip_item` when Start is pressed, with the
 *    count the admin saw; a saved filter edited later changes nothing. One row per person, and a unique index on the
 *    phone number across every queue: once each, forever.
 *  - **It stops itself and never restarts itself.** A selected number dropping, WhatsApp reporting a restriction, or
 *    three failed sends in a day pauses the whole queue and alerts the admins. Only a person presses Resume.
 *  - **Restart-safe.** All state is in the database. A message that was being sent when the server died is marked
 *    failed ("interrupted") and never retried: a double message to a stranger is worse than a missed one.
 */
import { toInternational } from '@ipropy/shared';
import { db, transaction } from '../../../db/pool.js';
import { logger } from '../../../utils/logger.js';
import { BadRequestError, NotFoundError } from '../../../utils/errors.js';
import { organisationTimezone } from '../../../core/settings/timezone.js';
import { recordService } from '../../../core/entity/recordService.js';
import type { ScopeContext } from '../../../core/permissions/index.js';
import { getModule } from '../../../core/metadata/registry.js';
import { filterOptedOut } from '../../../core/consent/index.js';
import { OpenWaError, openWaCheckNumber, openWaSession } from './openwa.js';
import { listNumbers, type WaNumber } from './waNumbers.js';
import { sendOnBusinessNumber } from './send.js';
import { SendLimitError } from './openwaGuards.js';
import { alertAdmins } from './numberAlerts.js';
import {
  capForDay, chooseDripNumber, clampSpeed, composeMessage, DEFAULT_VARIANTS, gapSeconds, hourIn, indianMobileKey,
  inWindow, MOST_PER_DRIP, pauseCause, SKIP_WORDS, usableFirstName, variantsProblem,
  type DripSpeed, type NumberState, type PauseCause, type SkipReason,
} from './dripRules.js';

const LINK = '/admin/whatsapp-drip';
/** Above this, Start needs a second, explicit confirmation. */
export const NEEDS_CONFIRMING = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DripRow {
  id: string; name: string; module_name: string; audience: { view?: string }; variants: string[]; number_ids: string[];
  status: 'draft' | 'running' | 'paused' | 'stopped' | 'done'; pause_reason: string | null; paused_by_system: boolean;
  cap_start: number; cap_step: number; cap_every_days: number; cap_max: number;
  gap_min_seconds: number; gap_max_seconds: number; window_from: number; window_to: number;
  max_total: number | null; approved_count: number | null; next_send_at: string | null;
  created_by: string | null; started_by: string | null; started_at: string | null; finished_at: string | null;
  created_at: string; updated_at: string;
}

const speedOf = (d: DripRow): DripSpeed => clampSpeed({
  capStart: d.cap_start, capStep: d.cap_step, capEveryDays: d.cap_every_days, capMax: d.cap_max,
  gapMinSeconds: d.gap_min_seconds, gapMaxSeconds: d.gap_max_seconds, windowFrom: d.window_from, windowTo: d.window_to,
});

interface Candidate { recordId: string; label: string; firstName: string | null; handle: string }
interface Left { recordId: string; label: string; handle: string; reason: SkipReason }

// ---------------------------------------------------------------------------
// Reading the audience
// ---------------------------------------------------------------------------

async function phoneFieldNames(moduleName: string): Promise<string[]> {
  const module = await getModule(moduleName);
  return (module?.fields ?? []).filter((field) => field.uitype === 'phone').map((field) => field.name);
}

/** First phone on the record that is an Indian mobile (ten digits), or why not. */
export function mobileOf(values: Record<string, unknown>, phoneFields: string[]): { handle: string } | { reason: SkipReason } {
  let sawANumber = false;
  for (const name of phoneFields) {
    const raw = typeof values[name] === 'string' ? values[name] as string : '';
    if (!raw.replace(/\D/g, '')) continue;
    sawANumber = true;
    const international = toInternational(values.country_code as string | undefined, raw);
    const key = indianMobileKey(international ?? raw);
    if (key) return { handle: key };
  }
  return { reason: sawANumber ? 'not_indian_mobile' : 'no_mobile' };
}

/**
 * Everyone on a saved list, split into people who can be messaged and people who cannot (with the reason). Done the
 * same way at preview and at Start, so the number shown is the number frozen.
 */
async function resolveAudience(ctx: ScopeContext, moduleName: string, view: string): Promise<{
  candidates: Candidate[]; left: Left[]; total: number;
}> {
  if (!view) throw new BadRequestError('Choose a saved list. The drip never guesses who "everybody" is.');
  const phoneFields = await phoneFieldNames(moduleName);
  const found: Candidate[] = [];
  const left: Left[] = [];
  const seen = new Set<string>();
  let total!: number;
  const pageSize = 200;
  for (let page = 1; ; page += 1) {
    const result = await recordService.listRecords(ctx, moduleName, { view, page, pageSize });
    total = result.total;
    for (const row of result.rows) {
      const mobile = mobileOf(row.values, phoneFields);
      if ('reason' in mobile) { left.push({ recordId: row.id, label: row.label, handle: '', reason: mobile.reason }); continue; }
      if (seen.has(mobile.handle)) { left.push({ recordId: row.id, label: row.label, handle: mobile.handle, reason: 'duplicate' }); continue; }
      seen.add(mobile.handle);
      found.push({ recordId: row.id, label: row.label, firstName: usableFirstName(row.values.first_name), handle: mobile.handle });
    }
    if (page * pageSize >= result.total || !result.rows.length) break;
    if (found.length > MOST_PER_DRIP) break;
  }

  // Opt-outs (the same list a customer's STOP writes to), then numbers the queue has already messaged.
  const stopped = await filterOptedOut(found.map((c) => `+91${c.handle}`), 'whatsapp');
  const already = await db.query<{ handle: string }>(
    `SELECT handle FROM ipy_wa_drip_item WHERE handle = ANY($1::text[]) AND status IN ('sending', 'sent')`,
    [found.map((c) => c.handle)],
  );
  const alreadySet = new Set(already.rows.map((r) => r.handle));
  const kept: Candidate[] = [];
  for (const c of found) {
    if (stopped.has(`+91${c.handle}`)) left.push({ recordId: c.recordId, label: c.label, handle: c.handle, reason: 'opted_out' });
    else if (alreadySet.has(c.handle)) left.push({ recordId: c.recordId, label: c.label, handle: c.handle, reason: 'already_messaged' });
    else kept.push(c);
  }
  return { candidates: kept, left, total };
}

const maskedNumber = (handle: string): string => `+91 ${handle.slice(0, 2)}******${handle.slice(-2)}`;

export interface DripPreview {
  total: number;
  reachable: number;
  skippedByReason: { reason: SkipReason; words: string; count: number }[];
  sample: { label: string; to: string; text: string }[];
  problem: string | null;
}

export async function previewDrip(input: { ctx: ScopeContext; moduleName: string; view: string; variants: string[] }): Promise<DripPreview> {
  const problem = variantsProblem(input.variants);
  const found = await resolveAudience(input.ctx, input.moduleName, input.view);
  const counts = new Map<SkipReason, number>();
  for (const l of found.left) counts.set(l.reason, (counts.get(l.reason) ?? 0) + 1);
  return {
    total: found.total,
    reachable: found.candidates.length,
    skippedByReason: [...counts].map(([reason, count]) => ({ reason, words: SKIP_WORDS[reason], count })),
    sample: problem ? [] : found.candidates.slice(0, 3).map((c) => ({
      label: c.label, to: maskedNumber(c.handle), text: composeMessage(input.variants, c.recordId, c.firstName).text,
    })),
    problem,
  };
}

// ---------------------------------------------------------------------------
// Writing: create, start, pause, resume, stop
// ---------------------------------------------------------------------------

async function event(dripId: string, kind: string, userId: string | null, detail: string | null, numberId: string | null = null): Promise<void> {
  await db.query(
    `INSERT INTO ipy_wa_drip_event (drip_id, kind, user_id, number_id, detail) VALUES ($1,$2,$3,$4,$5)`,
    [dripId, kind, userId, numberId, detail],
  );
}

export async function readDrip(id: string): Promise<DripRow> {
  const row = await db.queryOne<DripRow>(`SELECT * FROM ipy_wa_drip WHERE id = $1`, [id]);
  if (!row) throw new NotFoundError('No such queue.');
  return row;
}

/** Numbers that can carry a queue right now: linked and ready, not paused, with no WhatsApp restriction. */
async function assertNumbersUsable(numberIds: string[]): Promise<void> {
  if (numberIds.length === 0) throw new BadRequestError('Choose at least one WhatsApp number to send from.');
  const all = await listNumbers();
  for (const id of numberIds) {
    const n = all.find((x) => x.id === id);
    if (!n) throw new BadRequestError('One of the chosen numbers does not exist any more.');
    const name = n.label || n.sessionName;
    if (n.status !== 'ready') throw new BadRequestError(`${name} is not connected (${n.statusText}). Take it off the queue or reconnect it first.`);
    if (n.paused) throw new BadRequestError(`${name} is paused on the WhatsApp numbers screen. Un-pause it or take it off the queue.`);
    const live = await openWaSession({ fresh: true, name: n.sessionName }).catch((err) => { throw new BadRequestError(`Cannot reach ${name}: ${(err as Error).message}`); });
    if (live.restriction) throw new BadRequestError(`WhatsApp has limited ${name} (${live.restriction.kind}). Leave it out.`);
  }
}

export interface DripInput {
  name: string; view: string; moduleName?: string; variants: string[]; numberIds: string[];
  maxTotal?: number | null; speed?: Partial<Record<keyof DripSpeed, unknown>>;
}

export async function createDrip(input: DripInput & { userId: string }): Promise<{ id: string }> {
  const problem = variantsProblem(input.variants);
  if (problem) throw new BadRequestError(problem);
  if (!input.view) throw new BadRequestError('Choose a saved list.');
  const s = clampSpeed(input.speed);
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_wa_drip (name, module_name, audience, variants, number_ids, cap_start, cap_step, cap_every_days, cap_max,
                              gap_min_seconds, gap_max_seconds, window_from, window_to, max_total, created_by)
     VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::uuid[],$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [
      input.name.trim().slice(0, 120) || 'Promotional drip', input.moduleName ?? 'leads', JSON.stringify({ view: input.view }),
      JSON.stringify(input.variants.map((v) => v.trim())), input.numberIds,
      s.capStart, s.capStep, s.capEveryDays, s.capMax, s.gapMinSeconds, s.gapMaxSeconds, s.windowFrom, s.windowTo,
      input.maxTotal && input.maxTotal > 0 ? Math.floor(input.maxTotal) : null, input.userId,
    ],
  );
  await event(row!.id, 'created', input.userId, `Saved list, ${input.variants.length} wording(s), ${input.numberIds.length} number(s).`);
  return { id: row!.id };
}

/** Change a queue that is not running: the wordings, the numbers, the speed (always clamped), the "stop after". */
export async function updateDrip(id: string, userId: string, patch: Partial<Pick<DripInput, 'name' | 'variants' | 'numberIds' | 'maxTotal' | 'speed'>>): Promise<DripRow> {
  const drip = await readDrip(id);
  if (drip.status === 'running') throw new BadRequestError('Pause the queue first, then change it.');
  if (drip.status === 'stopped' || drip.status === 'done') throw new BadRequestError('This queue is finished.');
  if (patch.variants) {
    const problem = variantsProblem(patch.variants);
    if (problem) throw new BadRequestError(problem);
  }
  const s = clampSpeed({
    capStart: drip.cap_start, capStep: drip.cap_step, capEveryDays: drip.cap_every_days, capMax: drip.cap_max,
    gapMinSeconds: drip.gap_min_seconds, gapMaxSeconds: drip.gap_max_seconds, windowFrom: drip.window_from, windowTo: drip.window_to,
    ...(patch.speed ?? {}),
  });
  await db.query(
    `UPDATE ipy_wa_drip SET name = $2, variants = $3::jsonb, number_ids = $4::uuid[], max_total = $5,
            cap_start = $6, cap_step = $7, cap_every_days = $8, cap_max = $9, gap_min_seconds = $10, gap_max_seconds = $11,
            window_from = $12, window_to = $13, updated_at = now() WHERE id = $1`,
    [
      id, (patch.name ?? drip.name).trim().slice(0, 120), JSON.stringify((patch.variants ?? drip.variants).map((v) => v.trim())),
      patch.numberIds ?? drip.number_ids,
      patch.maxTotal === undefined ? drip.max_total : (patch.maxTotal && patch.maxTotal > 0 ? Math.floor(patch.maxTotal) : null),
      s.capStart, s.capStep, s.capEveryDays, s.capMax, s.gapMinSeconds, s.gapMaxSeconds, s.windowFrom, s.windowTo,
    ],
  );
  await event(id, 'settings', userId, `Changed: ${Object.keys(patch).join(', ') || 'nothing'}.`);
  return readDrip(id);
}

export async function startDrip(input: {
  ctx: ScopeContext; userId: string; dripId: string; expectedCount: number; confirmLarge?: boolean;
}): Promise<{ frozen: number; skipped: number }> {
  const drip = await readDrip(input.dripId);
  if (drip.status !== 'draft') throw new BadRequestError('Only a queue that has not started can be started. Use Resume for a paused one.');
  const running = await db.queryOne<{ name: string }>(`SELECT name FROM ipy_wa_drip WHERE status = 'running'`);
  if (running) throw new BadRequestError(`"${running.name}" is already running. Only one queue runs at a time, so the pace stays slow. Pause or stop it first.`);
  const problem = variantsProblem(drip.variants);
  if (problem) throw new BadRequestError(problem);
  await assertNumbersUsable(drip.number_ids);

  const found = await resolveAudience(input.ctx, drip.module_name, drip.audience.view ?? '');
  const count = found.candidates.length;
  if (count !== input.expectedCount) {
    throw new BadRequestError(`This list is ${count} people now, not the ${input.expectedCount} you were shown. Check it and start again.`);
  }
  if (count === 0) throw new BadRequestError('Nobody on this list can be messaged.');
  if (count > MOST_PER_DRIP) throw new BadRequestError(`${count} is more than one queue holds (${MOST_PER_DRIP}). Narrow the list and run it in parts.`);
  if (count > NEEDS_CONFIRMING && !input.confirmLarge) {
    throw new BadRequestError(`${count} people is a large queue. Confirm it explicitly to go ahead.`);
  }

  const speed = speedOf(drip);
  await transaction(async (conn) => {
    let seq = 0;
    const chunk = 500;
    for (let i = 0; i < found.candidates.length; i += chunk) {
      const part = found.candidates.slice(i, i + chunk);
      await conn.query(
        `INSERT INTO ipy_wa_drip_item (drip_id, seq, record_id, label, first_name, handle)
         SELECT $1, t.seq, t.record_id, t.label, t.first_name, t.handle
           FROM unnest($2::int[], $3::uuid[], $4::text[], $5::text[], $6::text[]) AS t(seq, record_id, label, first_name, handle)`,
        [
          input.dripId, part.map(() => (seq += 1)), part.map((c) => c.recordId), part.map((c) => c.label),
          part.map((c) => c.firstName ?? ''), part.map((c) => c.handle),
        ],
      );
    }
    for (let i = 0; i < found.left.length; i += chunk) {
      const part = found.left.slice(i, i + chunk);
      await conn.query(
        `INSERT INTO ipy_wa_drip_item (drip_id, seq, record_id, label, handle, status, skip_reason)
         SELECT $1, 0, t.record_id, t.label, t.handle, 'skipped', t.reason
           FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[]) AS t(record_id, label, handle, reason)
         ON CONFLICT DO NOTHING`,
        [input.dripId, part.map((l) => l.recordId), part.map((l) => l.label), part.map((l) => l.handle), part.map((l) => l.reason)],
      );
    }
    await conn.query(
      `UPDATE ipy_wa_drip SET status = 'running', pause_reason = NULL, paused_by_system = false, approved_count = $2,
              started_by = $3, started_at = now(), next_send_at = now() + make_interval(secs => $4::int), updated_at = now()
        WHERE id = $1`,
      [input.dripId, count, input.userId, gapSeconds(speed)],
    );
  });
  await event(input.dripId, 'started', input.userId, `Started for ${count} people (${found.left.length} left out), from ${drip.number_ids.length} number(s).`);
  return { frozen: count, skipped: found.left.length };
}

export async function pauseDrip(id: string, userId: string): Promise<DripRow> {
  const done = await db.query(
    `UPDATE ipy_wa_drip SET status = 'paused', pause_reason = 'Paused by an admin.', paused_by_system = false, updated_at = now()
      WHERE id = $1 AND status = 'running' RETURNING id`, [id]);
  if (!done.rowCount) throw new BadRequestError('Only a running queue can be paused.');
  await event(id, 'paused', userId, 'Paused by an admin.');
  return readDrip(id);
}

export async function resumeDrip(id: string, userId: string, numberIds?: string[]): Promise<DripRow> {
  const drip = await readDrip(id);
  if (drip.status !== 'paused') throw new BadRequestError('Only a paused queue can be resumed.');
  const running = await db.queryOne<{ name: string }>(`SELECT name FROM ipy_wa_drip WHERE status = 'running'`);
  if (running) throw new BadRequestError(`"${running.name}" is already running.`);
  const numbers = numberIds?.length ? numberIds : drip.number_ids;
  await assertNumbersUsable(numbers);
  const speed = speedOf(drip);
  await db.query(
    `UPDATE ipy_wa_drip SET status = 'running', pause_reason = NULL, paused_by_system = false, number_ids = $2::uuid[],
            started_by = $3, next_send_at = now() + make_interval(secs => $4::int), updated_at = now() WHERE id = $1`,
    [id, numbers, userId, gapSeconds(speed)],
  );
  await event(id, 'resumed', userId, numberIds?.length ? `Resumed on ${numbers.length} number(s).` : 'Resumed.');
  return readDrip(id);
}

/** Final. Nothing more is sent from this queue; people not yet messaged stay un-messaged. */
export async function stopDrip(id: string, userId: string): Promise<DripRow> {
  const done = await db.query(
    `UPDATE ipy_wa_drip SET status = 'stopped', finished_at = now(), updated_at = now()
      WHERE id = $1 AND status IN ('running', 'paused', 'draft') RETURNING id`, [id]);
  if (!done.rowCount) throw new BadRequestError('This queue has already finished.');
  await event(id, 'stopped', userId, 'Stopped by an admin. People not yet messaged will not be.');
  return readDrip(id);
}

// ---------------------------------------------------------------------------
// Reading: the screen
// ---------------------------------------------------------------------------

export interface DripNumberUse { numberId: string; label: string; status: string; paused: boolean; sentToday: number; capToday: number }

export interface DripSummary {
  id: string; name: string; status: DripRow['status']; pauseReason: string | null; pausedBySystem: boolean;
  approvedCount: number | null; maxTotal: number | null; startedAt: string | null; nextSendAt: string | null;
  variants: string[]; numberIds: string[]; speed: DripSpeed;
  counts: { pending: number; sent: number; failed: number; skipped: number };
  capToday: number;
  numbers: DripNumberUse[];
  insideWindow: boolean;
  repliedStop: number;
}

async function activeDaysBeforeToday(dripId: string, tz: string): Promise<number> {
  const r = await db.queryOne<{ n: string }>(
    `SELECT COUNT(DISTINCT (sent_at AT TIME ZONE $2)::date) AS n FROM ipy_wa_drip_item
      WHERE drip_id = $1 AND status = 'sent' AND (sent_at AT TIME ZONE $2)::date < (now() AT TIME ZONE $2)::date`,
    [dripId, tz],
  );
  return Number(r?.n ?? 0);
}

async function sentTodayByNumber(tz: string): Promise<Map<string, { today: number; lastMs: number | null }>> {
  const { rows } = await db.query<{ number_id: string; today: string; last_ms: string | null }>(
    `SELECT number_id,
            COUNT(*) FILTER (WHERE (sent_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date) AS today,
            (EXTRACT(EPOCH FROM MAX(sent_at)) * 1000)::bigint AS last_ms
       FROM ipy_wa_drip_item WHERE status = 'sent' AND number_id IS NOT NULL GROUP BY number_id`,
    [tz],
  );
  return new Map(rows.map((r) => [r.number_id, { today: Number(r.today), lastMs: r.last_ms ? Number(r.last_ms) : null }]));
}

async function failuresLastDay(dripId: string): Promise<number> {
  const r = await db.queryOne<{ n: string }>(
    `SELECT COUNT(*) AS n FROM ipy_wa_drip_item
      WHERE drip_id = $1 AND status = 'failed' AND attempted_at >= now() - interval '1 day'
        AND coalesce(error, '') NOT LIKE 'Interrupted%'`, [dripId]);
  return Number(r?.n ?? 0);
}

async function restrictedNames(numbers: WaNumber[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const n of numbers) {
    if (n.status !== 'ready') continue;
    try {
      const s = await openWaSession({ name: n.sessionName });
      if (s.restriction) out.add(n.id);
    } catch { /* unreachable shows up as the number not being ready */ }
  }
  return out;
}

export async function dripSummaries(): Promise<DripSummary[]> {
  const tz = await organisationTimezone();
  const { rows } = await db.query<DripRow>(`SELECT * FROM ipy_wa_drip ORDER BY (status = 'running') DESC, (status = 'paused') DESC, created_at DESC LIMIT 30`);
  const numbers = await listNumbers();
  const used = await sentTodayByNumber(tz);
  const out: DripSummary[] = [];
  for (const d of rows) {
    const speed = speedOf(d);
    const c = await db.queryOne<{ pending: string; sent: string; failed: string; skipped: string }>(
      `SELECT COUNT(*) FILTER (WHERE status IN ('pending', 'sending')) AS pending, COUNT(*) FILTER (WHERE status = 'sent') AS sent,
              COUNT(*) FILTER (WHERE status = 'failed') AS failed, COUNT(*) FILTER (WHERE status = 'skipped') AS skipped
         FROM ipy_wa_drip_item WHERE drip_id = $1`, [d.id]);
    const stop = await db.queryOne<{ n: string }>(
      `SELECT COUNT(*) AS n FROM ipy_wa_drip_item i
        WHERE i.drip_id = $1 AND i.status = 'sent'
          AND EXISTS (SELECT 1 FROM ipy_channel_optout o WHERE o.channel = 'whatsapp' AND right(regexp_replace(o.handle, '\\D', '', 'g'), 10) = i.handle)`,
      [d.id]);
    const capToday = capForDay(d.status === 'draft' ? 0 : await activeDaysBeforeToday(d.id, tz), speed);
    out.push({
      id: d.id, name: d.name, status: d.status, pauseReason: d.pause_reason, pausedBySystem: d.paused_by_system,
      approvedCount: d.approved_count, maxTotal: d.max_total, startedAt: d.started_at, nextSendAt: d.next_send_at,
      variants: d.variants, numberIds: d.number_ids, speed,
      counts: { pending: Number(c?.pending ?? 0), sent: Number(c?.sent ?? 0), failed: Number(c?.failed ?? 0), skipped: Number(c?.skipped ?? 0) },
      capToday,
      numbers: d.number_ids.map((id) => {
        const n = numbers.find((x) => x.id === id);
        return {
          numberId: id, label: n ? (n.label || n.sessionName) : 'removed number', status: n?.status ?? 'missing', paused: n?.paused ?? false,
          sentToday: used.get(id)?.today ?? 0, capToday,
        };
      }),
      insideWindow: inWindow(hourIn(tz), speed),
      repliedStop: Number(stop?.n ?? 0),
    });
  }
  return out;
}

export async function dripDetail(id: string): Promise<{
  events: { id: string; at: string; kind: string; detail: string | null; by: string | null; number: string | null }[];
  recent: { id: string; label: string | null; status: string; skipReason: string | null; error: string | null; at: string | null; number: string | null; text: string | null }[];
}> {
  await readDrip(id);
  const events = await db.query<{ id: string; at: string; kind: string; detail: string | null; by: string | null; number: string | null }>(
    `SELECT e.id, e.at, e.kind, e.detail, trim(u.first_name || ' ' || u.last_name) AS by, coalesce(n.label, n.session_name) AS number
       FROM ipy_wa_drip_event e LEFT JOIN ipy_user u ON u.id = e.user_id LEFT JOIN ipy_wa_number n ON n.id = e.number_id
      WHERE e.drip_id = $1 ORDER BY e.at DESC LIMIT 60`, [id]);
  const recent = await db.query<{ id: string; label: string | null; status: string; skip_reason: string | null; error: string | null; at: string | null; number: string | null; text: string | null }>(
    `SELECT i.id, i.label, i.status, i.skip_reason, i.error, coalesce(i.sent_at, i.attempted_at) AS at,
            coalesce(n.label, n.session_name) AS number, left(m.body, 200) AS text
       FROM ipy_wa_drip_item i LEFT JOIN ipy_wa_number n ON n.id = i.number_id LEFT JOIN ipy_message m ON m.id = i.message_id
      WHERE i.drip_id = $1 AND i.status IN ('sent', 'failed', 'sending') ORDER BY coalesce(i.sent_at, i.attempted_at) DESC NULLS LAST LIMIT 40`, [id]);
  return {
    events: events.rows,
    recent: recent.rows.map((r) => ({ id: r.id, label: r.label, status: r.status, skipReason: r.skip_reason, error: r.error, at: r.at, number: r.number, text: r.text })),
  };
}

/** Why items were left out of a queue, with counts: the screen's "who was skipped and why". */
export async function dripSkips(id: string): Promise<{ reason: string; words: string; count: number }[]> {
  const { rows } = await db.query<{ reason: string; n: string }>(
    `SELECT skip_reason AS reason, COUNT(*) AS n FROM ipy_wa_drip_item WHERE drip_id = $1 AND status = 'skipped' GROUP BY skip_reason ORDER BY COUNT(*) DESC`, [id]);
  return rows.map((r) => ({ reason: r.reason, words: SKIP_WORDS[r.reason as SkipReason] ?? r.reason, count: Number(r.n) }));
}

export function defaultVariants(): string[] { return [...DEFAULT_VARIANTS]; }

// ---------------------------------------------------------------------------
// A test to one number the admin owns — through the ordinary send path, not the queue
// ---------------------------------------------------------------------------

export async function sendDripTest(input: { userId: string; mobile: string; numberId: string; variants: string[] }): Promise<{ to: string; text: string }> {
  const problem = variantsProblem(input.variants);
  if (problem) throw new BadRequestError(problem);
  const key = indianMobileKey(input.mobile);
  if (!key) throw new BadRequestError('Type a ten-digit Indian mobile number.');
  const record = await db.queryOne<{ id: string; name: string | null }>(
    `SELECT r.id, to_jsonb(l)->>'first_name' AS name
       FROM ipy_record r JOIN ipy_e_leads l ON l.record_id = r.id
      WHERE r.is_deleted = false AND r.archived_at IS NULL
        AND (right(regexp_replace(coalesce(to_jsonb(l)->>'mobile', ''), '\\D', '', 'g'), 10) = $1
          OR right(regexp_replace(coalesce(to_jsonb(l)->>'whatsapp_number', ''), '\\D', '', 'g'), 10) = $1)
      ORDER BY r.updated_at DESC LIMIT 1`, [key]);
  if (!record) {
    throw new BadRequestError('That number is not a contact in the CRM. Add yourself as a contact first (the CRM only messages people it has a record for), then test.');
  }
  const { text } = composeMessage(input.variants, record.id, usableFirstName(record.name));
  // The ordinary path: spacing, daily cap per person, opt-out and the number's own state all apply. Not counted by the queue.
  await sendOnBusinessNumber({ userId: input.userId, to: `91${key}`, text, recordId: record.id, route: 'chat', numberId: input.numberId, isAdmin: true });
  return { to: maskedNumber(key), text };
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

async function autoPause(drip: DripRow, cause: PauseCause, numberId: string | null = null): Promise<void> {
  const done = await db.query(
    `UPDATE ipy_wa_drip SET status = 'paused', pause_reason = $2, paused_by_system = true, updated_at = now()
      WHERE id = $1 AND status = 'running' RETURNING id`, [drip.id, cause.message]);
  if (!done.rowCount) return;
  await event(drip.id, 'auto_paused', null, cause.message, numberId);
  logger.warn({ drip: drip.id, why: cause.why }, 'whatsapp drip paused itself');
  await alertAdmins(`WhatsApp queue "${drip.name}" paused itself`, cause.message, LINK)
    .catch((err) => logger.warn({ err }, 'could not alert the admins about the drip'));
}

async function schedule(dripId: string, seconds: number): Promise<void> {
  await db.query(`UPDATE ipy_wa_drip SET next_send_at = now() + make_interval(secs => $2::int), updated_at = now() WHERE id = $1`, [dripId, Math.max(1, Math.round(seconds))]);
}

async function finish(drip: DripRow, why: string): Promise<void> {
  const done = await db.query(
    `UPDATE ipy_wa_drip SET status = 'done', finished_at = now(), updated_at = now() WHERE id = $1 AND status = 'running' RETURNING id`, [drip.id]);
  if (done.rowCount) await event(drip.id, 'finished', null, why);
}

async function optedOutNow(handle: string): Promise<boolean> {
  const row = await db.queryOne<{ ok: number }>(
    `SELECT 1 AS ok FROM ipy_channel_optout
      WHERE channel = 'whatsapp' AND right(regexp_replace(handle, '\\D', '', 'g'), 10) = $1 LIMIT 1`, [handle]);
  return Boolean(row);
}

async function markSkipped(itemId: string, reason: SkipReason): Promise<void> {
  await db.query(`UPDATE ipy_wa_drip_item SET status = 'skipped', skip_reason = $2 WHERE id = $1`, [itemId, reason]);
}

interface ItemRow { id: string; record_id: string; label: string | null; first_name: string | null; handle: string }

/** Was this number already confirmed (or ruled out) as a WhatsApp number? Asks WhatsApp once if the CRM has no answer. */
async function onWhatsApp(item: ItemRow, via: WaNumber): Promise<'yes' | 'no'> {
  const known = await db.queryOne<{ status: string; number: string | null }>(`SELECT status, number FROM ipy_wa_lookup WHERE record_id = $1`, [item.record_id]);
  if (known && (known.number ?? '').replace(/\D/g, '').slice(-10) === item.handle) {
    if (known.status === 'not_on_whatsapp') return 'no';
    if (known.status === 'on_whatsapp') return 'yes';
  }
  const found = await openWaCheckNumber(`91${item.handle}`, via.sessionName);
  await db.query(
    `INSERT INTO ipy_wa_lookup (record_id, number, status, photo, checked_at, number_id) VALUES ($1,$2,$3,'none', now(), $4)
     ON CONFLICT (record_id) DO UPDATE SET number = EXCLUDED.number, status = EXCLUDED.status, checked_at = now(), number_id = EXCLUDED.number_id`,
    [item.record_id, `91${item.handle}`, found.exists ? 'on_whatsapp' : 'not_on_whatsapp', via.id],
  );
  return found.exists ? 'yes' : 'no';
}

const MAX_SKIPS_PER_TICK = 25;
let ticking = false;

/**
 * One pass of the clock. Sends at most ONE message, and only if the running queue is due, the hour is right, a number
 * is ready and under today's cap, and nothing says stop. Exported for the tests; production calls it every 15 seconds.
 */
export async function dripTick(now: Date = new Date(), random: () => number = Math.random): Promise<'idle' | 'sent' | 'waiting' | 'paused' | 'done'> {
  const drip = await db.queryOne<DripRow>(`SELECT * FROM ipy_wa_drip WHERE status = 'running' AND (next_send_at IS NULL OR next_send_at <= now()) LIMIT 1`);
  if (!drip) return 'idle';
  const speed = speedOf(drip);
  const tz = await organisationTimezone();
  if (!inWindow(hourIn(tz, now), speed)) return 'waiting';

  const admin = drip.started_by
    ? await db.queryOne<{ id: string }>(`SELECT id FROM ipy_user WHERE id = $1 AND is_admin AND is_active AND deleted_at IS NULL`, [drip.started_by])
    : null;
  if (!admin) {
    await autoPause(drip, { why: 'number_down', message: 'The admin who started this queue is no longer an active admin. Another admin can press Resume.' });
    return 'paused';
  }

  // How many it may still send: the total, then the number states.
  const sentSoFar = Number((await db.queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM ipy_wa_drip_item WHERE drip_id = $1 AND status = 'sent'`, [drip.id]))?.n ?? 0);
  if (drip.max_total !== null && sentSoFar >= drip.max_total) { await finish(drip, `Reached the limit of ${drip.max_total} messages you set.`); return 'done'; }

  const all = await listNumbers();
  const used = await sentTodayByNumber(tz);
  const restricted = await restrictedNames(all.filter((n) => drip.number_ids.includes(n.id)));
  const states: NumberState[] = drip.number_ids.map((id) => {
    const n = all.find((x) => x.id === id);
    return {
      id, label: n ? (n.label || n.sessionName) : 'a removed number', status: n?.status ?? 'missing', paused: n?.paused ?? false,
      sentToday: used.get(id)?.today ?? 0, lastSentAtMs: used.get(id)?.lastMs ?? null, restricted: restricted.has(id),
    };
  });
  const cause = pauseCause({ numbers: states, failuresLastDay: await failuresLastDay(drip.id) });
  if (cause) { await autoPause(drip, cause); return 'paused'; }

  const capToday = capForDay(await activeDaysBeforeToday(drip.id, tz), speed);
  const chosen = chooseDripNumber(states, capToday);
  if (!chosen) { await schedule(drip.id, 15 * 60); return 'waiting'; }
  const number = all.find((n) => n.id === chosen.id)!;

  for (let tries = 0; tries < MAX_SKIPS_PER_TICK; tries += 1) {
    const item = await db.queryOne<ItemRow>(
      `SELECT id, record_id, label, first_name, handle FROM ipy_wa_drip_item WHERE drip_id = $1 AND status = 'pending' ORDER BY seq LIMIT 1`, [drip.id]);
    if (!item) { await finish(drip, 'Everyone on the list has been messaged or left out.'); return 'done'; }

    const alive = await db.queryOne<{ ok: number }>(`SELECT 1 AS ok FROM ipy_record WHERE id = $1 AND is_deleted = false AND archived_at IS NULL`, [item.record_id]);
    if (!alive) { await markSkipped(item.id, 'record_gone'); continue; }
    // Checked again here, not only at Start: somebody can reply STOP in between.
    if (await optedOutNow(item.handle)) { await markSkipped(item.id, 'opted_out'); continue; }

    // Claimed before anything is sent. The unique index on the number refuses a second claim of the same phone.
    try {
      const claimed = await db.query(`UPDATE ipy_wa_drip_item SET status = 'sending', attempted_at = now() WHERE id = $1 AND status = 'pending' RETURNING id`, [item.id]);
      if (!claimed.rowCount) continue;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') { await markSkipped(item.id, 'already_messaged'); continue; }
      throw err;
    }

    let reachable: 'yes' | 'no';
    try {
      reachable = await onWhatsApp(item, number);
    } catch (err) {
      await db.query(`UPDATE ipy_wa_drip_item SET status = 'pending', attempted_at = NULL WHERE id = $1`, [item.id]);
      if (err instanceof OpenWaError) {
        await autoPause(drip, { why: 'number_down', message: `${chosen.label} could not be reached to check a number: ${err.message}` }, chosen.id);
        return 'paused';
      }
      await schedule(drip.id, 300);
      return 'waiting';
    }
    if (reachable === 'no') {
      await markSkipped(item.id, 'not_on_whatsapp');
      // A WhatsApp lookup is a query WhatsApp sees: not two in a row.
      await schedule(drip.id, 8 + random() * 12);
      return 'waiting';
    }

    const { text, variant } = composeMessage(drip.variants, item.record_id, usableFirstName(item.first_name));
    try {
      const sent = await sendOnBusinessNumber({
        userId: admin.id, to: `91${item.handle}`, text, recordId: item.record_id, route: 'chat', numberId: chosen.id, isAdmin: true, fromQueue: true,
      });
      await db.query(
        `UPDATE ipy_wa_drip_item SET status = 'sent', sent_at = now(), number_id = $2, message_id = $3, variant = $4 WHERE id = $1`,
        [item.id, chosen.id, sent.messageId, variant],
      );
      const left = await db.queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM ipy_wa_drip_item WHERE drip_id = $1 AND status = 'pending'`, [drip.id]);
      if (Number(left?.n ?? 0) === 0) await finish(drip, 'Everyone on the list has been messaged or left out.');
      else if (drip.max_total !== null && sentSoFar + 1 >= drip.max_total) await finish(drip, `Reached the limit of ${drip.max_total} messages you set.`);
      else await schedule(drip.id, gapSeconds(speed, random));
      return 'sent';
    } catch (err) {
      const message = (err as Error).message;
      if (err instanceof SendLimitError) {
        // A brake said wait (spacing, quiet hours, a per-customer cap): nothing failed, so nothing is counted.
        await db.query(`UPDATE ipy_wa_drip_item SET status = 'pending', attempted_at = NULL WHERE id = $1`, [item.id]);
        await schedule(drip.id, err.limit === 'TOO_SOON' ? 120 : 15 * 60);
        return 'waiting';
      }
      if (/opted out/i.test(message)) { await markSkipped(item.id, 'opted_out'); continue; }
      if (/not connected|Nothing was sent|is paused by an admin|no longer exists|does not exist/i.test(message)) {
        await db.query(`UPDATE ipy_wa_drip_item SET status = 'pending', attempted_at = NULL WHERE id = $1`, [item.id]);
        await autoPause(drip, { why: 'number_down', message: `${chosen.label}: ${message}` }, chosen.id);
        return 'paused';
      }
      await db.query(`UPDATE ipy_wa_drip_item SET status = 'failed', error = $2, number_id = $3, attempted_at = now() WHERE id = $1`, [item.id, message.slice(0, 300), chosen.id]);
      const failures = await failuresLastDay(drip.id);
      const stop = pauseCause({ numbers: states, failuresLastDay: failures });
      if (stop) { await autoPause(drip, stop, chosen.id); return 'paused'; }
      await schedule(drip.id, gapSeconds(speed, random));
      return 'waiting';
    }
  }
  // 25 people in a row were left out: look again in a minute rather than hold the clock.
  await schedule(drip.id, 60);
  return 'waiting';
}

/** A message that was being sent when the server stopped: failed, and never retried. */
export async function recoverInterruptedSends(): Promise<number> {
  const r = await db.query(
    `UPDATE ipy_wa_drip_item SET status = 'failed', error = 'Interrupted by a restart; not retried, so nobody gets two messages.'
      WHERE status = 'sending' AND attempted_at < now() - interval '5 minutes' RETURNING id`);
  return r.rowCount ?? 0;
}

let timer: NodeJS.Timeout | null = null;

export function startDripSending(): void {
  if (timer) return;
  void recoverInterruptedSends().catch(() => undefined);
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    dripTick()
      .catch((err) => logger.error({ err }, 'whatsapp drip tick failed'))
      .finally(() => { ticking = false; });
  }, 15_000);
  timer.unref?.();
}

export function stopDripSending(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
