/**
 * Whether this deployment is still being served.
 *
 * A customer's CRM is its own process against its own database and knows
 * nothing about the control plane, so "suspended" in the customer list could
 * not, by itself, stop anybody working. This is the other half: the control
 * plane writes a flag into the customer's own database, and the app reads it
 * here. No cross-database call on the request path, and it keeps working if the
 * control plane is down.
 *
 * Cached for a minute rather than invalidated on write, because the write comes
 * from a different process entirely. A minute is the right order of magnitude
 * for a billing decision — nobody is counting seconds — and it keeps this off
 * the database on every request.
 */
import { db } from '../db/pool.js';
import { logger } from '../utils/logger.js';

export const SERVICE_STATUS_KEY = 'service.status';

export interface ServiceStatus {
  suspended: boolean;
  /** Shown to the user. Deliberately theirs to read, not an internal code. */
  message: string;
}

const ACTIVE: ServiceStatus = { suspended: false, message: '' };
const CACHE_MS = 60_000;

let cached: ServiceStatus = ACTIVE;
let readAt = 0;

export async function getServiceStatus(): Promise<ServiceStatus> {
  if (Date.now() - readAt < CACHE_MS) return cached;

  try {
    const row = await db.queryOne<{ value: { status?: string; message?: string } }>(
      `SELECT value FROM ipy_setting WHERE key = $1`,
      [SERVICE_STATUS_KEY],
    );
    cached = row?.value?.status === 'suspended'
      ? {
        suspended: true,
        message: row.value.message
          || 'This account is paused. Please contact iPropy to restore access.',
      }
      : ACTIVE;
  } catch (err) {
    // A database that cannot be read is a bigger problem than billing, and the
    // request will fail on its own a moment later. Never lock a paying customer
    // out because one query blipped.
    logger.warn({ err }, 'could not read the service status; assuming active');
    cached = ACTIVE;
  }

  readAt = Date.now();
  return cached;
}

/** Used by the control plane, and by tests that need the next read to be fresh. */
export function forgetServiceStatus(): void {
  readAt = 0;
}

export async function setServiceStatus(suspended: boolean, message = ''): Promise<void> {
  await db.query(
    `INSERT INTO ipy_setting (key, value, category, label, description)
     VALUES ($1, $2, 'billing', 'Service status', 'Set by iPropy when an account is paused or restored')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [SERVICE_STATUS_KEY, JSON.stringify({ status: suspended ? 'suspended' : 'active', message })],
  );
  forgetServiceStatus();
}
