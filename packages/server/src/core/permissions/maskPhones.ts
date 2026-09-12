/**
 * Hiding customer phone numbers from the team, without stopping them working.
 *
 * The risk this answers is the oldest one in this industry: a rep leaves and the
 * customer list leaves with them. A CRM that shows every number on a list view
 * is a CRM that can be copied in an afternoon.
 *
 * Three things had to be true at once, and only the third is obvious:
 *
 *  1. **The masking is server-side.** Blanking it in React would be theatre —
 *    the real number would still be one devtools tab away, in the same response.
 *    So the value never leaves the server for someone who may not see it.
 *  2. **They can still ring the customer.** Calls are `tel:` links built from
 *    the value, so masking alone would take the phone away as well as the
 *    number. `revealPhone` hands back one number, for one record, and writes an
 *    audit row every time. Harvesting a thousand numbers now means a thousand
 *    audit rows with a name against them.
 *  3. **Admins are exempt**, as everywhere else in this file.
 *
 * `98xxxxxx56` rather than `**********`: enough to recognise a number you
 * already know, useless for building a list.
 *
 * Which numbers are masked is a **field permission**, not a global switch:
 * a profile sets a field to `owner_only` in Roles & Profiles and the value then
 * reads normally for whoever the record is assigned to and masked for everybody
 * else. Migration 099 moved it there, and says why.
 */
import type { AuthUser } from '@ipropy/shared';
import { db } from '../../db/pool.js';
import { registry } from '../metadata/registry.js';
import { getFieldPermissions } from './index.js';

/**
 * `9811421156` → `98xxxxxx56`.
 *
 * Digits only for the count, so `+91 98114 21156` and `9811421156` mask to the
 * same shape. Anything under six digits is returned as-is: masking a four-digit
 * extension to `xx` hides nothing and looks broken.
 */
export function maskNumber(raw: unknown): unknown {
  if (typeof raw !== 'string' || !raw.trim()) return raw;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 6) return raw;
  return `${digits.slice(0, 2)}${'x'.repeat(digits.length - 4)}${digits.slice(-2)}`;
}

/**
 * Which fields this viewer sees masked on this record.
 *
 * Driven by the profile's field permissions rather than a global switch, and
 * record-aware: `owner_only` means the person the record is assigned to reads
 * the number normally and everybody else gets `98xxxxxx56`. That is the rule
 * the risk actually wants — the rep working the lead has to be able to ring
 * them; nobody else needs the list.
 *
 * `ownerId` is the record's. Passing `null` — a list row with no owner, a
 * context with no record — masks, because "not yours" is the safe reading of
 * "unknown".
 *
 * Not restricted to phone fields any more. `owner_only` is a permission an
 * admin can set on any field, and the masking is the same idea whatever the
 * field holds; `maskNumber` leaves anything without six digits untouched.
 */
export async function maskedPhoneFields(
  user: AuthUser,
  moduleName: string,
  ownerId?: string | null,
): Promise<Set<string>> {
  if (user.isAdmin) return new Set();
  const module = await registry.getModule(moduleName);
  if (!module) return new Set();
  if (ownerId && ownerId === user.id) return new Set();

  const perms = await getFieldPermissions(user, moduleName);
  const masked = new Set<string>();
  for (const [name, permission] of perms) {
    if (permission === 'owner_only') masked.add(name);
  }
  return masked;
}

/**
 * The real number for one record, and a note in the audit log that it was asked for.
 *
 * Deliberately one at a time and deliberately noisy. Somebody ringing forty
 * customers a day is ordinary and leaves forty rows; somebody quietly building a
 * list leaves a trail that says so.
 */
export async function revealPhone(
  user: AuthUser,
  moduleName: string,
  recordId: string,
  fieldName: string,
): Promise<string | null> {
  const module = await registry.getModule(moduleName);
  /*
    Any field the masking can hide, not only a phone.

    `owner_only` stopped being phone-specific in migration 099 and this check
    did not follow, so a field of any other type could be masked and then
    revealed by nobody — the value shown as `98xxx43` to everyone except its
    owner and an admin, with the reveal silently answering null and no
    explanation anywhere. That defeats the whole reason there are two settings:
    `hidden` means no, `owner_only` means yes, on the record and in the log.

    It bites hardest on an email, because `maskNumber` masks anything holding
    six digits — `rakesh.kumar9876543@gmail.com` renders as `98xxx43` — so the
    field most likely to be set `owner_only` after the phone is also the one
    that was least recoverable.
  */
  const field = module?.fields.find((f) => f.name === fieldName);
  if (!module || !field) return null;

  // A field the profile hides outright is not revealable. Only the masked
  // middle ground has a reveal, which is the point of having two settings:
  // `hidden` means no, `owner_only` means yes but on the record and in the log.
  if (!user.isAdmin) {
    const perms = await getFieldPermissions(user, moduleName);
    if (perms.get(fieldName) === 'hidden') return null;
  }

  const column = field.storage === 'json'
    ? `custom_fields->>'${field.columnName}'`
    : `"${field.columnName}"`;
  const row = await db.queryOne<{ value: string | null }>(
    `SELECT ${column} AS value FROM ${module.tableName} WHERE record_id = $1`, [recordId],
  );
  if (!row?.value) return null;

  await db.query(
    // Still `phone_revealed`: the action name is what every existing audit row,
    // filter and report already says, and renaming it would silently split the
    // trail in two. The field is in `changes` for anything that needs to know
    // which one it was.
    `INSERT INTO ipy_audit (record_id, module_name, action, changes, user_id, source)
     VALUES ($1, $2, 'phone_revealed', $3, $4, 'app')`,
    [recordId, moduleName, JSON.stringify({ field: fieldName, uitype: field.uitype }), user.id],
  );

  return row.value;
}
