/**
 * Synced, idle or offline — the decision, away from the screen that draws it.
 *
 * In `lib/` rather than beside the component for the reason this repo has met
 * before: a `node` test that imports a component pulls in the app's store,
 * which reads `localStorage` as it is constructed and fails before a single
 * assertion runs. `waDigits` moved for the same reason.
 */

/** The app says so every minute; two is one missed beat, not an absence. */
const OPEN_WITHIN_MS = 2 * 60_000;
/** Beyond this, "it was on at some point today" stops being reassuring. */
const IDLE_WITHIN_MS = 12 * 60 * 60_000;

export type Reachability = 'open' | 'idle' | 'offline' | 'never';

export interface PhoneRow {
  id: string;
  label: string;
  model: string | null;
  app_version: string | null;
  user_name: string | null;
  is_active: boolean;
  last_sync_at: string | null;
  last_sync_count: number;
  last_seen_at: string | null;
  app_open_at: string | null;
  last_dial_status: string | null;
  last_dial_at: string | null;
  call_count: number;
}

/**
 * Pure, and exported for its test: the whole value of this screen is that the
 * three states mean exactly what they say.
 */
export function reachability(row: Pick<PhoneRow, 'app_open_at' | 'last_seen_at'>, now = Date.now()): Reachability {
  const open = row.app_open_at ? now - new Date(row.app_open_at).getTime() : Infinity;
  if (open <= OPEN_WITHIN_MS) return 'open';
  const seen = row.last_seen_at ? now - new Date(row.last_seen_at).getTime() : Infinity;
  if (!Number.isFinite(seen)) return 'never';
  return seen <= IDLE_WITHIN_MS ? 'idle' : 'offline';
}

