/**
 * Where the team is, and which property they are standing at.
 *
 * The question this answers is "did they get to the site". Not "where is
 * everybody", which is a different and much worse question, and not "how fast
 * were they driving", which this deliberately cannot tell you.
 *
 * Three things shape the whole design:
 *
 * * **Off by default, and on a schedule when on.** Recording staff movements is
 *   not a feature to switch on quietly, and there is rarely a business reason
 *   to know where somebody sleeps. Both the hours and the on switch are
 *   settings, so it is his decision rather than mine.
 *
 * * **The visible range follows the role hierarchy**, exactly like records do.
 *   An admin sees everybody, a manager sees the people under them, everybody
 *   else sees themselves. There is no separate answer to "who may look", which
 *   is what stops this becoming the one part of the CRM with its own rules.
 *
 * * **A phone fix is worth ten to twenty metres on a good day.** That is enough
 *   to say somebody reached Greenfield Colony and nowhere near enough to say
 *   which of two adjacent builder floors they walked into. Everything here
 *   reports a distance alongside the match so nobody reads more into a dot than
 *   it can carry.
 */
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { getSubordinateUserIds } from '../permissions/index.js';
import { organisationTimezone } from '../settings/timezone.js';
import type { AuthUser } from '@ipropy/shared';

export interface LocationSettings {
  enabled: boolean;
  everyMinutes: number;
  fromHour: number;
  toHour: number;
  keepDays: number;
  siteRadiusM: number;
}

const FALLBACK: LocationSettings = {
  enabled: false, everyMinutes: 15, fromHour: 9, toHour: 20, keepDays: 30, siteRadiusM: 150,
};

const KEYS: Record<keyof LocationSettings, string> = {
  enabled: 'team_location.enabled',
  everyMinutes: 'team_location.every_minutes',
  fromHour: 'team_location.from_hour',
  toHour: 'team_location.to_hour',
  keepDays: 'team_location.keep_days',
  siteRadiusM: 'team_location.site_radius_m',
};

let cached: LocationSettings | null = null;

export function invalidateLocationSettings(): void {
  cached = null;
}

function clamp(raw: unknown, low: number, high: number, fallback: number): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(high, Math.max(low, Math.round(n)));
}

export async function locationSettings(): Promise<LocationSettings> {
  if (cached) return cached;
  try {
    const rows = await db.query<{ key: string; value: unknown }>(
      `SELECT key, value FROM ipy_setting WHERE key = ANY($1)`,
      [Object.values(KEYS)],
    );
    const map = new Map(rows.rows.map((r) => [r.key, r.value]));
    cached = {
      enabled: map.get(KEYS.enabled) === true || map.get(KEYS.enabled) === 'true',
      // Fifteen is the floor because WorkManager will not schedule a periodic
      // job more often than that, and WorkManager is what the app uses — a
      // foreground service could go faster and would cost a notification the
      // rep cannot dismiss and still be killed by Xiaomi's battery manager.
      // Accepting a smaller number here would be promising something the phone
      // cannot do.
      everyMinutes: clamp(map.get(KEYS.everyMinutes), 15, 240, FALLBACK.everyMinutes),
      fromHour: clamp(map.get(KEYS.fromHour), 0, 23, FALLBACK.fromHour),
      toHour: clamp(map.get(KEYS.toHour), 0, 23, FALLBACK.toHour),
      keepDays: clamp(map.get(KEYS.keepDays), 1, 365, FALLBACK.keepDays),
      siteRadiusM: clamp(map.get(KEYS.siteRadiusM), 25, 2000, FALLBACK.siteRadiusM),
    };
    return cached;
  } catch (err) {
    logger.warn({ err }, 'could not read team location settings, using defaults');
    return FALLBACK;
  }
}

/**
 * What the phone should be doing right now.
 *
 * Answered here rather than in the app, because the app is the hardest thing in
 * this system to change — it needs a rebuild, a re-install and somebody holding
 * the handset. A rep on last month's build has to be able to be switched off
 * from the CRM, and that is only true if the phone asks rather than decides.
 */
export async function currentPolicy(): Promise<{
  enabled: boolean; everyMinutes: number; withinHours: boolean;
}> {
  const settings = await locationSettings();
  if (!settings.enabled) return { enabled: false, everyMinutes: settings.everyMinutes, withinHours: false };

  // Both hours the same means around the clock, which is the only sane reading
  // of "from 0 to 0" and the escape hatch for a business that needs it.
  const round = settings.fromHour === settings.toHour;
  const zone = await organisationTimezone();
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, hour12: false, hour: '2-digit',
  }).format(new Date()));

  const within = round
    || (settings.fromHour < settings.toHour
      ? hour >= settings.fromHour && hour < settings.toHour
      // A window that wraps midnight — a night shift — is still a window.
      : hour >= settings.fromHour || hour < settings.toHour);

  return { enabled: true, everyMinutes: settings.everyMinutes, withinHours: within };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface Fix {
  latitude: number;
  longitude: number;
  recordedAt: number;
  accuracyM?: number | null;
  speedMps?: number | null;
  batteryPct?: number | null;
}

/** Metres between two coordinates. Haversine, which is plenty at this scale. */
export function metresBetween(
  aLat: number, aLon: number, bLat: number, bLon: number,
): number {
  const R = 6_371_000;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

interface SitedProperty { id: string; latitude: number; longitude: number }

/**
 * Properties that have coordinates.
 *
 * Read fresh every time, and not cached. The instinct is to hold this for a
 * minute, and the arithmetic says not to: a batch arrives once per phone per
 * fifteen minutes, so ten reps produce forty of these queries an hour against a
 * table of tens of rows. A cache saves nothing measurable and buys one real
 * bug — a property added this minute is not matched, which is exactly the
 * moment somebody is standing at it wondering why the map has not noticed.
 *
 * Checked in memory rather than with a spatial index because there are tens of
 * properties, not thousands, and an index is a thing somebody has to maintain.
 */
async function sitedProperties(): Promise<SitedProperty[]> {
  const { rows } = await db.query<SitedProperty>(
    `SELECT p.record_id AS id, p.latitude::float8 AS latitude, p.longitude::float8 AS longitude
       FROM ipy_e_properties p
       JOIN ipy_record r ON r.id = p.record_id
      WHERE r.is_deleted = false
        AND p.latitude IS NOT NULL AND p.longitude IS NOT NULL`,
  );
  return rows;
}

/** The nearest property within the radius, or nothing. */
async function nearestSite(
  latitude: number, longitude: number, radiusM: number,
): Promise<{ id: string; metres: number } | null> {
  let best: { id: string; metres: number } | null = null;
  for (const property of await sitedProperties()) {
    const metres = metresBetween(latitude, longitude, property.latitude, property.longitude);
    if (metres <= radiusM && (!best || metres < best.metres)) best = { id: property.id, metres };
  }
  return best;
}

export interface RecordResult { stored: number; skipped: number; reason?: string }

/**
 * Store a batch of fixes from one phone.
 *
 * Rejects rather than silently drops when the feature is off, so a handset on
 * an old build that keeps sending gets a clear answer and can stop.
 */
export async function recordFixes(
  userId: string, deviceId: string | null, fixes: Fix[],
): Promise<RecordResult> {
  const settings = await locationSettings();
  if (!settings.enabled) return { stored: 0, skipped: fixes.length, reason: 'Location recording is switched off.' };
  if (!fixes.length) return { stored: 0, skipped: 0 };

  const now = Date.now();
  let stored = 0;
  let skipped = 0;

  for (const fix of fixes) {
    // A fix from the future, or from before this feature existed, is a clock
    // problem on the handset rather than a place somebody was.
    if (!Number.isFinite(fix.latitude) || !Number.isFinite(fix.longitude)) { skipped += 1; continue; }
    if (Math.abs(fix.latitude) > 90 || Math.abs(fix.longitude) > 180) { skipped += 1; continue; }
    if (fix.recordedAt > now + 5 * 60_000 || fix.recordedAt < now - 30 * 24 * 60 * 60_000) {
      skipped += 1;
      continue;
    }

    const near = await nearestSite(fix.latitude, fix.longitude, settings.siteRadiusM);
    await db.query(
      `INSERT INTO ipy_device_location
         (user_id, device_id, recorded_at, latitude, longitude, accuracy_m, speed_mps,
          battery_pct, near_record_id, near_metres)
       VALUES ($1,$2,to_timestamp($3::double precision / 1000),$4,$5,$6,$7,$8,$9,$10)`,
      [
        userId, deviceId, fix.recordedAt, fix.latitude, fix.longitude,
        fix.accuracyM ?? null, fix.speedMps ?? null, fix.batteryPct ?? null,
        near?.id ?? null, near?.metres ?? null,
      ],
    );
    stored += 1;
  }

  return { stored, skipped };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface TeamPosition {
  userId: string;
  name: string;
  latitude: number;
  longitude: number;
  recordedAt: string;
  accuracyM: number | null;
  batteryPct: number | null;
  /** The property they are at, if any, and how far from its pin. */
  atProperty: { id: string; label: string; metres: number } | null;
  /** How long they have been within the radius of that property. */
  atPropertyMinutes: number | null;
}

/** Whose positions this person is allowed to see. */
async function visibleUserIds(user: AuthUser): Promise<string[] | null> {
  if (user.isAdmin) return null; // everybody
  const subordinates = await getSubordinateUserIds(user);
  return [user.id, ...subordinates];
}

/**
 * The newest position for everybody in view.
 *
 * `DISTINCT ON` rather than a window function: it is the one thing Postgres
 * does better than anybody, it uses the index directly, and "newest row per
 * person" is exactly what it is for.
 */
export async function teamPositions(user: AuthUser): Promise<TeamPosition[]> {
  const allowed = await visibleUserIds(user);
  const settings = await locationSettings();

  const { rows } = await db.query<{
    user_id: string; name: string; latitude: number; longitude: number;
    recorded_at: string; accuracy_m: number | null; battery_pct: number | null;
    near_record_id: string | null; near_metres: number | null; near_label: string | null;
  }>(
    `SELECT DISTINCT ON (l.user_id)
            l.user_id,
            trim(u.first_name || ' ' || u.last_name) AS name,
            l.latitude::float8 AS latitude, l.longitude::float8 AS longitude,
            l.recorded_at, l.accuracy_m, l.battery_pct,
            l.near_record_id, l.near_metres, r.label AS near_label
       FROM ipy_device_location l
       JOIN ipy_user u ON u.id = l.user_id
       LEFT JOIN ipy_record r ON r.id = l.near_record_id
      WHERE ($1::uuid[] IS NULL OR l.user_id = ANY($1::uuid[]))
        AND u.is_active = true AND u.deleted_at IS NULL
        AND l.recorded_at > now() - ($2 || ' days')::interval
      ORDER BY l.user_id, l.recorded_at DESC`,
    [allowed, settings.keepDays],
  );

  return Promise.all(rows.map(async (row) => ({
    userId: row.user_id,
    name: row.name,
    latitude: row.latitude,
    longitude: row.longitude,
    recordedAt: row.recorded_at,
    accuracyM: row.accuracy_m,
    batteryPct: row.battery_pct,
    atProperty: row.near_record_id
      ? { id: row.near_record_id, label: row.near_label ?? 'a property', metres: Math.round(row.near_metres ?? 0) }
      : null,
    atPropertyMinutes: row.near_record_id ? await minutesAt(row.user_id, row.near_record_id) : null,
  })));
}

/**
 * How long somebody has been at the property they are at now.
 *
 * From the first point in the current unbroken run at that property. A rep who
 * arrived, left for lunch and came back reads as having just arrived, which is
 * the honest answer — the alternative is claiming they stood there for hours.
 */
async function minutesAt(userId: string, recordId: string): Promise<number | null> {
  const row = await db.queryOne<{ minutes: number }>(
    `WITH ordered AS (
       SELECT recorded_at, near_record_id,
              lag(near_record_id) OVER (ORDER BY recorded_at DESC) AS newer
         FROM ipy_device_location
        WHERE user_id = $1 AND recorded_at > now() - interval '12 hours'
        ORDER BY recorded_at DESC
        LIMIT 300
     ),
     run AS (
       SELECT recorded_at FROM ordered
        WHERE near_record_id IS NOT DISTINCT FROM $2::uuid
          AND recorded_at > COALESCE((
            SELECT max(recorded_at) FROM ordered
             WHERE near_record_id IS DISTINCT FROM $2::uuid
          ), '-infinity'::timestamptz)
     )
     SELECT EXTRACT(EPOCH FROM (now() - min(recorded_at))) / 60 AS minutes FROM run`,
    [userId, recordId],
  );
  const minutes = Number(row?.minutes ?? 0);
  return Number.isFinite(minutes) ? Math.round(minutes) : null;
}

export interface TrailPoint {
  latitude: number; longitude: number; recordedAt: string;
  accuracyM: number | null; nearLabel: string | null;
}

/** One person's path over a window, oldest first, for drawing a line. */
export async function trail(
  user: AuthUser, userId: string, hours = 12,
): Promise<TrailPoint[]> {
  const allowed = await visibleUserIds(user);
  if (allowed && !allowed.includes(userId)) return [];

  const { rows } = await db.query<{
    latitude: number; longitude: number; recorded_at: string;
    accuracy_m: number | null; near_label: string | null;
  }>(
    `SELECT l.latitude::float8 AS latitude, l.longitude::float8 AS longitude,
            l.recorded_at, l.accuracy_m, r.label AS near_label
       FROM ipy_device_location l
       LEFT JOIN ipy_record r ON r.id = l.near_record_id
      WHERE l.user_id = $1 AND l.recorded_at > now() - ($2 || ' hours')::interval
      ORDER BY l.recorded_at
      LIMIT 2000`,
    [userId, Math.min(168, Math.max(1, hours))],
  );

  return rows.map((row) => ({
    latitude: row.latitude,
    longitude: row.longitude,
    recordedAt: row.recorded_at,
    accuracyM: row.accuracy_m,
    nearLabel: row.near_label,
  }));
}

/**
 * Delete what is older than the retention setting.
 *
 * Called from the scheduler. This is the part of the feature that makes the
 * rest of it defensible: the data answers nothing after a few weeks, and the
 * cheapest way to keep it safe is not to keep it.
 */
export async function pruneOldLocations(): Promise<number> {
  const settings = await locationSettings();
  const result = await db.query(
    `DELETE FROM ipy_device_location WHERE recorded_at < now() - ($1 || ' days')::interval`,
    [settings.keepDays],
  );
  const removed = result.rowCount ?? 0;
  if (removed) logger.info({ removed, keepDays: settings.keepDays }, 'old location points deleted');
  return removed;
}
