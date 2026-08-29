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
 */
import type { AuthUser } from '@ipropy/shared';
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { registry } from '../metadata/registry.js';

const SETTING_KEY = 'privacy.mask_phone_numbers';

let cached: boolean | null = null;

export function invalidatePhoneMasking(): void {
  cached = null;
}

export async function maskingOn(): Promise<boolean> {
  if (cached !== null) return cached;
  try {
    const row = await db.queryOne<{ value: unknown }>(
      `SELECT value FROM ipy_setting WHERE key = $1`, [SETTING_KEY],
    );
    cached = row?.value === true;
    return cached;
  } catch (err) {
    // Off on failure. A settings read that fails must not start hiding data the
    // team needs to do its job.
    logger.warn({ err }, 'could not read the phone-masking setting');
    return false;
  }
}

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
 * Which fields on this module hold a phone number.
 *
 * By uitype rather than by name: an admin can add "Husband's number" as a phone
 * field tomorrow, and a list of names would not know about it. Empty when
 * masking is off or the viewer is an admin, so the caller does no work.
 */
export async function maskedPhoneFields(user: AuthUser, moduleName: string): Promise<Set<string>> {
  if (user.isAdmin) return new Set();
  if (!(await maskingOn())) return new Set();
  const module = await registry.getModule(moduleName);
  if (!module) return new Set();
  return new Set(module.fields.filter((f) => f.uitype === 'phone').map((f) => f.name));
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
  const field = module?.fields.find((f) => f.name === fieldName && f.uitype === 'phone');
  if (!module || !field) return null;

  const column = field.storage === 'json'
    ? `custom_fields->>'${field.columnName}'`
    : `"${field.columnName}"`;
  const row = await db.queryOne<{ value: string | null }>(
    `SELECT ${column} AS value FROM ${module.tableName} WHERE record_id = $1`, [recordId],
  );
  if (!row?.value) return null;

  await db.query(
    `INSERT INTO ipy_audit (record_id, module_name, action, changes, user_id, source)
     VALUES ($1, $2, 'phone_revealed', $3, $4, 'app')`,
    [recordId, moduleName, JSON.stringify({ field: fieldName }), user.id],
  );

  return row.value;
}
