/**
 * Vtiger user id -> iPropy user id, matched by email. Owners and
 * created-by/modified-by all resolve through this — get it wrong and every
 * migrated lead is silently reassigned to the wrong rep.
 */
import type { Tx } from '../../db/pool.js';
import type { VtigerRow } from './transform.js';

export interface Crosswalk {
  resolve(vtigerUserId: string | undefined): string | undefined;
  unmapped: { vtigerUserId: string; email: string }[];
}

export async function buildUserCrosswalk(conn: Tx, vtigerUsers: VtigerRow[]): Promise<Crosswalk> {
  const ipropyUsers = await conn.query<{ id: string; email: string }>(
    `SELECT id, email FROM ipy_user WHERE deleted_at IS NULL`,
  );
  const byEmail = new Map(ipropyUsers.rows.map((u) => [u.email.toLowerCase(), u.id]));

  const map = new Map<string, string>();
  const unmapped: { vtigerUserId: string; email: string }[] = [];

  for (const row of vtigerUsers) {
    const vtigerId = String(row.id ?? '');
    const email = String(row.email1 ?? '').trim().toLowerCase();
    if (!vtigerId) continue;
    const matched = email ? byEmail.get(email) : undefined;
    if (matched) map.set(vtigerId, matched);
    else unmapped.push({ vtigerUserId: vtigerId, email });
  }

  return {
    resolve: (vtigerUserId) => (vtigerUserId ? map.get(vtigerUserId) : undefined),
    unmapped,
  };
}
