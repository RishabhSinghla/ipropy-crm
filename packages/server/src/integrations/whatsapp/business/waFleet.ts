/**
 * Looking after the whole fleet of WhatsApp numbers, not just one.
 *
 *  - Capacity: the OpenWA server is a small paid machine. Too many linked numbers at once runs it out of memory and
 *    takes the company number down with it, so starting one more than the plan can hold is refused in plain words.
 *  - Watchdog: a number that was working and has dropped is restarted, slowly (1, 5, 15, 30, 60 minutes) and at most
 *    five times, then left alone for a person. It never touches a number an admin stopped on purpose.
 *  - Every minute the status, last error and "last changed" time of every number are refreshed.
 *
 * The decisions are small pure functions at the top so they can be tested without OpenWA.
 */
import { db } from '../../../db/pool.js';
import { logger } from '../../../utils/logger.js';
import { BadRequestError } from '../../../utils/errors.js';
import { getIntegrationConfig } from '../../../core/settings/integrations.js';
import { OPENWA_PROVIDER, openWaManage, openWaMetricsText } from './openwa.js';
import { syncFromOpenWa } from './waNumbers.js';

/** Statuses in which a session holds a Chromium-free but real chunk of memory. */
const LIVE_STATUSES = ['ready', 'initializing', 'authenticating', 'qr_ready', 'starting'];
/** Statuses that mean "was working, has dropped" — the only ones the watchdog may act on. */
const DROPPED_STATUSES = ['disconnected', 'failed', 'error'];

export const RESTART_WAIT_SECONDS = [60, 300, 900, 1800, 3600];
export const MAX_RESTART_ATTEMPTS = RESTART_WAIT_SECONDS.length;

export interface Capacity { maxLive: number; memoryLimitMb: number }
export const DEFAULT_CAPACITY: Capacity = { maxLive: 3, memoryLimitMb: 512 };

export function readCapacity(raw: unknown): Capacity {
  const v = (raw ?? {}) as Record<string, unknown>;
  const clamp = (x: unknown, fallback: number, min: number, max: number): number => {
    const n = Math.round(Number(x));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    maxLive: clamp(v.maxLive, DEFAULT_CAPACITY.maxLive, 1, 40),
    memoryLimitMb: clamp(v.memoryLimitMb, DEFAULT_CAPACITY.memoryLimitMb, 256, 65536),
  };
}

/** Resident memory in bytes from OpenWA's Prometheus text, or null if it is not there. */
export function rssFromMetrics(text: string): number | null {
  const m = /^openwa_process_resident_memory_bytes\s+([0-9.eE+-]+)/m.exec(text);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) ? n : null;
}

export interface RoomVerdict { ok: boolean; reason: string | null }

/**
 * May one more number be started? `rssMb` is optional (only known when the OpenWA metrics token is set). A number
 * that is already live may always be restarted: it holds its seat.
 */
export function roomToStart(input: { capacity: Capacity; liveCount: number; alreadyLive: boolean; rssMb: number | null }): RoomVerdict {
  if (input.alreadyLive) return { ok: true, reason: null };
  const { maxLive, memoryLimitMb } = input.capacity;
  if (input.liveCount >= maxLive) {
    return {
      ok: false,
      reason: `The OpenWA server is sized for ${maxLive} connected numbers and ${input.liveCount} are connected. `
        + 'Another would risk running it out of memory and taking the company number down. It needs the bigger Render plan first '
        + '(see docs/OPENWA.md, "Upgrading the OpenWA server"), then raise the limit on this screen.',
    };
  }
  if (input.rssMb !== null && input.rssMb > memoryLimitMb * 0.8) {
    return {
      ok: false,
      reason: `The OpenWA server is already using ${Math.round(input.rssMb)} MB of ${memoryLimitMb} MB. `
        + 'Starting another number now could crash it. It needs the bigger Render plan first (see docs/OPENWA.md).',
    };
  }
  return { ok: true, reason: null };
}

export type WatchdogAction = 'none' | 'restart' | 'give_up';

export function watchdogDecision(n: {
  status: string; wantedRunning: boolean; hasPhone: boolean; attempts: number; nextRestartAt: Date | null; now: Date;
}): WatchdogAction {
  if (!n.wantedRunning || !n.hasPhone) return 'none';
  if (!DROPPED_STATUSES.includes(n.status)) return 'none';
  if (n.attempts >= MAX_RESTART_ATTEMPTS) return 'give_up';
  if (n.nextRestartAt && n.nextRestartAt.getTime() > n.now.getTime()) return 'none';
  return 'restart';
}

// ---------------------------------------------------------------------------

export async function loadCapacity(): Promise<Capacity> {
  const row = await db.queryOne<{ value: unknown }>(`SELECT value FROM ipy_setting WHERE key = 'whatsapp.capacity'`);
  return readCapacity(row?.value);
}

export async function saveCapacity(next: Capacity): Promise<Capacity> {
  const clean = readCapacity(next);
  await db.query(
    `INSERT INTO ipy_setting (key, value, category, label, updated_at)
     VALUES ('whatsapp.capacity', $1::jsonb, 'whatsapp', 'WhatsApp numbers the OpenWA server can hold', now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(clean)],
  );
  return clean;
}

async function currentRssMb(): Promise<number | null> {
  try {
    const text = await openWaMetricsText();
    const rss = text ? rssFromMetrics(text) : null;
    return rss === null ? null : rss / 1024 / 1024;
  } catch {
    return null;
  }
}

export interface FleetSummary { capacity: Capacity; live: number; rssMb: number | null; room: RoomVerdict }

export async function fleetSummary(numberId?: string): Promise<FleetSummary> {
  const [capacity, rssMb, counts] = await Promise.all([
    loadCapacity(),
    currentRssMb(),
    db.queryOne<{ live: string; mine: boolean | null }>(
      `SELECT COUNT(*) FILTER (WHERE status = ANY($1) AND wanted_running) AS live,
              bool_or(id = $2::uuid AND status = ANY($1)) AS mine
         FROM ipy_wa_number`, [LIVE_STATUSES, numberId ?? null]),
  ]);
  const live = Number(counts?.live ?? 0);
  return { capacity, live, rssMb, room: roomToStart({ capacity, liveCount: live, alreadyLive: Boolean(counts?.mine), rssMb }) };
}

/** Called before a number is started. Throws the plain-words reason when there is no room. */
export async function assertRoomToStart(numberId: string): Promise<void> {
  const s = await fleetSummary(numberId);
  if (!s.room.ok) throw new BadRequestError(s.room.reason ?? 'There is no room for another number.');
}

// ---------------------------------------------------------------------------
// The minute timer
// ---------------------------------------------------------------------------

export async function fleetTick(now: Date = new Date()): Promise<void> {
  const before = await db.query<{ id: string; status: string }>(`SELECT id, status FROM ipy_wa_number`);
  const old = new Map(before.rows.map((r) => [r.id, r.status]));
  await syncFromOpenWa(); // refreshes status and phone of every session in one OpenWA call

  const { rows } = await db.query<{
    id: string; session_name: string; session_id: string | null; status: string; phone: string | null;
    wanted_running: boolean; restart_attempts: number; next_restart_at: Date | null;
  }>(`SELECT id, session_name, session_id, status, phone, wanted_running, restart_attempts, next_restart_at FROM ipy_wa_number`);

  let restartedThisTick = false;
  for (const n of rows) {
    if (old.get(n.id) !== n.status) {
      logger.info({ number: n.session_name, from: old.get(n.id) ?? null, to: n.status }, 'whatsapp number status changed');
    }
    if (n.status === 'ready') {
      if (n.restart_attempts > 0 || n.next_restart_at) {
        await db.query(`UPDATE ipy_wa_number SET restart_attempts = 0, next_restart_at = NULL, last_error = NULL WHERE id = $1`, [n.id]);
      }
      continue;
    }
    const action = watchdogDecision({
      status: n.status, wantedRunning: n.wanted_running, hasPhone: Boolean(n.phone),
      attempts: n.restart_attempts, nextRestartAt: n.next_restart_at, now,
    });
    if (action === 'give_up') {
      await recordError(n.id, `Dropped and ${MAX_RESTART_ATTEMPTS} automatic restarts did not bring it back. Press Restart, or scan the QR again.`);
      continue;
    }
    // One restart per minute across the whole fleet, so a mass drop never turns into a stampede.
    if (action === 'restart' && !restartedThisTick && n.session_id) {
      restartedThisTick = true;
      const wait = RESTART_WAIT_SECONDS[Math.min(n.restart_attempts, RESTART_WAIT_SECONDS.length - 1)];
      await db.query(
        `UPDATE ipy_wa_number SET restart_attempts = restart_attempts + 1, next_restart_at = now() + ($2 || ' seconds')::interval WHERE id = $1`,
        [n.id, String(wait)],
      );
      try {
        await openWaManage(`/api/sessions/${n.session_id}/start`, { method: 'POST' });
        logger.warn({ number: n.session_name, attempt: n.restart_attempts + 1 }, 'whatsapp watchdog restarted a dropped number');
      } catch (err) {
        await recordError(n.id, `Automatic restart failed: ${(err as Error).message}`);
      }
    }
  }
}

export async function recordError(numberId: string, message: string): Promise<void> {
  await db.query(`UPDATE ipy_wa_number SET last_error = $2, last_error_at = now() WHERE id = $1`, [numberId, message.slice(0, 500)]);
}

const EVERY_MS = 60_000;
let timer: NodeJS.Timeout | null = null;
let running = false;

export function startFleetWatch(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (running || !getIntegrationConfig(OPENWA_PROVIDER)) return;
    running = true;
    void fleetTick()
      .catch((err) => logger.warn({ err }, 'whatsapp fleet check failed'))
      .finally(() => { running = false; });
  }, EVERY_MS);
  timer.unref?.();
}

export function stopFleetWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
