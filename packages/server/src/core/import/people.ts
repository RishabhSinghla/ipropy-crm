/**
 * "Rakesh" in a spreadsheet, and the user it means.
 *
 * An owner field stores a user id, and nobody's Excel file holds one. Without
 * this, mapping a perfectly ordinary Assigned To column failed every row with
 * "Assigned To must reference a valid record" — a true sentence that tells the
 * person nothing they can act on.
 *
 * Matched on email, full name, and first name, in that order of confidence. A
 * first name shared by two colleagues resolves to neither: guessing which
 * Rahul owns two hundred leads is not a guess worth making.
 */
import { db, type Tx } from '../../db/pool.js';

export interface People {
  /** folded key → user id, with ambiguous keys deliberately absent */
  byKey: Map<string, string>;
  /** user id → display name, for showing a preview a person can read */
  names: Map<string, string>;
  /** keys that name more than one colleague */
  ambiguous: Set<string>;
}

const fold = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

export async function loadPeople(conn: Tx = db): Promise<People> {
  const rows = await conn.query<{ id: string; name: string; email: string }>(
    `SELECT id, trim(concat_ws(' ', first_name, last_name)) AS name, email
       FROM ipy_user WHERE is_active = true AND deleted_at IS NULL`);

  const byKey = new Map<string, string>();
  const names = new Map<string, string>();
  const ambiguous = new Set<string>();

  const claim = (key: string, id: string): void => {
    if (!key) return;
    const held = byKey.get(key);
    if (held && held !== id) { ambiguous.add(key); byKey.delete(key); return; }
    if (ambiguous.has(key)) return;
    byKey.set(key, id);
  };

  for (const u of rows.rows) {
    names.set(u.id, u.name || u.email);
    // Email first and alone: it is the one key that cannot be ambiguous, so it
    // is claimed before any name can poison it.
    if (u.email) byKey.set(fold(u.email), u.id);
  }
  for (const u of rows.rows) {
    if (u.name) {
      claim(fold(u.name), u.id);
      const first = fold(u.name).split(' ')[0];
      if (first && first !== fold(u.name)) claim(first, u.id);
    }
  }
  return { byKey, names, ambiguous };
}

export function resolvePerson(raw: unknown, people: People): { id?: string; problem?: string } {
  const key = fold(String(raw));
  if (!key) return {};
  const id = people.byKey.get(key);
  if (id) return { id };
  if (people.ambiguous.has(key)) {
    return { problem: `“${String(raw).trim()}” is the name of more than one person here` };
  }
  return { problem: `there is nobody here called “${String(raw).trim()}”` };
}
