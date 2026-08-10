/**
 * Making "suspended" mean something to the customer.
 *
 * Setting a status in the customer list is bookkeeping; the customer's CRM is a
 * different process against a different database and would carry on serving.
 * This reaches into their database and sets the flag their own app reads
 * (`core/serviceStatus.ts`), which is what actually pauses them.
 *
 * A direct write rather than an API call because there is nothing to call: each
 * customer's deployment is theirs, may be asleep, and would need a shared
 * secret. The connection string we already hold is the simpler, more reliable
 * path.
 */
import { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { SERVICE_STATUS_KEY } from '../core/serviceStatus.js';
import * as store from './store.js';
import type { TenantStatus } from './types.js';

const PAUSED_MESSAGE = 'This account is paused. Please contact iPropy to restore access.';

/**
 * Best-effort by design.
 *
 * If their database is unreachable the customer list must still record the
 * decision — otherwise a Neon blip during a billing sweep silently leaves a
 * customer marked active and unpaid. The gap closes on the next sweep, and the
 * failure is logged loudly rather than thrown, so one unreachable customer does
 * not stop the other thirty-nine being processed.
 */
export async function writeServiceFlag(databaseUrl: string, suspended: boolean): Promise<boolean> {
  if (!databaseUrl) return false;

  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 10_000 });
  try {
    await pool.query(
      `INSERT INTO ipy_setting (key, value, category, label, description)
       VALUES ($1, $2, 'billing', 'Service status', 'Set by iPropy when an account is paused or restored')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [
        SERVICE_STATUS_KEY,
        JSON.stringify({ status: suspended ? 'suspended' : 'active', message: suspended ? PAUSED_MESSAGE : '' }),
      ],
    );
    return true;
  } catch (err) {
    logger.error({ err, suspended }, 'could not reach a customer database to change its service status');
    return false;
  } finally {
    await pool.end().catch(() => { /* already failed; nothing to salvage */ });
  }
}

/**
 * The one way to start or stop serving a customer.
 *
 * Everything that suspends or resumes — the command line, the console, a
 * webhook, the lapse sweep — goes through here, so there is a single place
 * where "we stopped serving them" and "their app knows" cannot drift apart.
 */
export async function setTenantService(
  tenantId: string, status: Extract<TenantStatus, 'active' | 'suspended'>, reason: string,
): Promise<{ reachedTheirDatabase: boolean }> {
  const tenants = await store.listTenants();
  const summary = tenants.find((t) => t.id === tenantId);
  const tenant = summary ? await store.requireBySlug(summary.slug) : null;

  await store.setStatus(tenantId, status);

  const reached = tenant
    ? await writeServiceFlag(tenant.databaseUrl, status === 'suspended')
    : false;

  await store.recordEvent(
    tenantId,
    status === 'suspended' ? 'suspend' : 'resume',
    reached ? reason : `${reason} — their database was unreachable, so their app has not been told yet`,
  );

  return { reachedTheirDatabase: reached };
}
