/**
 * The timezone this business runs in.
 *
 * Lived in the capture module until that was removed, and is needed well
 * outside it: any rule about "9am" or "today" has to mean 9am where the
 * business is, not where the container is. A server runs in UTC unless told
 * otherwise, which in India is five and a half hours out — enough to fire a
 * morning workflow in the middle of the previous afternoon.
 *
 * Cached briefly. It is read on nearly every scheduled rule and changes about
 * once in the life of a business.
 */
import { db } from '../../db/pool.js';

const TZ_TTL_MS = 60_000;
let orgTimezone: { value: string; readAt: number } | null = null;

export function invalidateOrganisationTimezone(): void {
  orgTimezone = null;
}

export async function organisationTimezone(): Promise<string> {
  if (orgTimezone && Date.now() - orgTimezone.readAt < TZ_TTL_MS) return orgTimezone.value;
  const row = await db.queryOne<{ value: string }>(
    `SELECT value #>> '{}' AS value FROM ipy_setting WHERE key = 'org.timezone'`,
  );
  const value = row?.value || 'Asia/Kolkata';
  orgTimezone = { value, readAt: Date.now() };
  return value;
}
