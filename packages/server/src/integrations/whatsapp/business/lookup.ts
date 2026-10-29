/**
 * WhatsApp Lookup: one number, one person at a time, by hand.
 *
 * "Who is this on WhatsApp?" — the profile name and picture, through the company's linked number (OpenWA). It is the
 * manual sibling of the bulk checker in `numberCheck.ts` and shares its picture code, but it is deliberately small
 * and slow-by-rule, because every lookup is a query WhatsApp sees about a third party from a real person's number:
 *
 *  - one number per press, never a list;
 *  - a gentle per-user pause (3 s), per-user hourly limit and a shared daily cap, all counted from the CRM's own log
 *    so a restart cannot reset them;
 *  - the same number is answered from a ten-minute memory without asking WhatsApp again (and costs nothing);
 *  - every real lookup is logged (who, number, result) for administrators.
 *
 * Saving the picture and name onto a CRM record is a separate, explicit press, and goes through the record's own
 * permissions as the person pressing it.
 */
import { db } from '../../../db/pool.js';
import { logger } from '../../../utils/logger.js';
import { toInternational } from '@ipropy/shared';
import { columnsOf, fieldText } from '../../../core/entity/payloadColumns.js';
import { recordService, type ServiceContext } from '../../../core/entity/recordService.js';
import { matchKey } from '../matchContact.js';
import { OpenWaError, openWaCheckNumber, openWaProfilePictureUrl, openWaPushName } from './openwa.js';
import { downloadProfilePhoto, storeAvatar } from './numberCheck.js';
import { defaultCountryCode } from './send.js';

export const LOOKUP_GAP_MS = 3_000;
export const LOOKUP_PER_USER_PER_HOUR = 30;
export const LOOKUP_DAILY_CAP = 300;
const CACHE_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// The number a person typed
// ---------------------------------------------------------------------------

/**
 * Whatever somebody pastes — "+91 98912-22206", "098912 22206", "9891222206", "00919891222206" — as the digits WhatsApp
 * needs, country code first. A bare number takes the organisation's own country code (a setting an admin can see).
 * Returns null when it cannot be a phone number.
 */
export function normaliseLookupNumber(input: string, defaultCode: string): string | null {
  let text = String(input ?? '').trim();
  if (text.startsWith('00')) text = `+${text.slice(2)}`;
  const digits = text.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  // A trunk zero in front of a national number ("098912 22206") is not part of it.
  const national = !text.startsWith('+') && digits.startsWith('0') ? digits.replace(/^0+/, '') : digits;
  const full = toInternational(defaultCode, text.startsWith('+') ? `+${digits}` : national);
  const out = (full ?? '').replace(/\D/g, '');
  return out.length >= 8 && out.length <= 15 ? out : null;
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

export interface LookupOutcome {
  status: 'on_whatsapp' | 'not_on_whatsapp' | 'disconnected' | 'rate_limited' | 'invalid';
  message: string;
  number: string | null;
  pushName: string | null;
  /** A small data: URL so the browser needs nothing from WhatsApp's CDN (those addresses expire). */
  avatar: string | null;
  fromCache: boolean;
}

interface Cached { at: number; status: 'on_whatsapp' | 'not_on_whatsapp'; pushName: string | null; photo: { data: Buffer; type: string } | null }
const cache = new Map<string, Cached>();
export function __resetLookupCache(): void { cache.clear(); }

const dataUrl = (photo: Cached['photo']): string | null => (photo ? `data:${photo.type};base64,${photo.data.toString('base64')}` : null);

function outcomeOf(number: string, hit: Cached, fromCache: boolean): LookupOutcome {
  return hit.status === 'on_whatsapp'
    ? { status: 'on_whatsapp', message: 'This number is on WhatsApp.', number, pushName: hit.pushName, avatar: dataUrl(hit.photo), fromCache }
    : { status: 'not_on_whatsapp', message: 'This number is not on WhatsApp.', number, pushName: null, avatar: null, fromCache };
}

async function log(userId: string, number: string, result: string, pushName: string | null, fromCache: boolean): Promise<void> {
  await db.query(
    `INSERT INTO ipy_wa_lookup_log (user_id, number, result, push_name, from_cache) VALUES ($1, $2, $3, $4, $5)`,
    [userId, number, result, pushName, fromCache],
  );
}

/** Why this person may not look something up right now, or null. Counted from the log, never from memory. */
async function refusal(userId: string): Promise<string | null> {
  const row = await db.queryOne<{ last_gap_ms: number | null; hour: number; day: number }>(
    `SELECT (SELECT (extract(epoch FROM (now() - max(created_at))) * 1000)::int FROM ipy_wa_lookup_log WHERE user_id = $1 AND NOT from_cache) AS last_gap_ms,
            (SELECT count(*)::int FROM ipy_wa_lookup_log WHERE user_id = $1 AND NOT from_cache AND created_at > now() - interval '1 hour') AS hour,
            (SELECT count(*)::int FROM ipy_wa_lookup_log WHERE NOT from_cache AND created_at > now() - interval '1 day') AS day`,
    [userId],
  );
  if (row && row.day >= LOOKUP_DAILY_CAP) return `Today's lookup allowance (${LOOKUP_DAILY_CAP}) is used up for the whole team. It protects the company WhatsApp number. Try again tomorrow.`;
  if (row && row.hour >= LOOKUP_PER_USER_PER_HOUR) return `You have used ${LOOKUP_PER_USER_PER_HOUR} lookups this hour. Please wait a little — this protects the company WhatsApp number.`;
  if (row?.last_gap_ms !== null && row?.last_gap_ms !== undefined && row.last_gap_ms < LOOKUP_GAP_MS) return 'One moment — lookups go one at a time, a few seconds apart.';
  return null;
}

export async function lookupNumber(userId: string, input: string): Promise<LookupOutcome> {
  const number = normaliseLookupNumber(input, await defaultCountryCode());
  if (!number) return { status: 'invalid', message: 'That does not look like a phone number.', number: null, pushName: null, avatar: null, fromCache: false };

  const hit = cache.get(number);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    await log(userId, number, hit.status, hit.pushName, true);
    return outcomeOf(number, hit, true);
  }

  const why = await refusal(userId);
  if (why) return { status: 'rate_limited', message: why, number, pushName: null, avatar: null, fromCache: false };

  try {
    const found = await openWaCheckNumber(number);
    if (!found.exists || !found.waId) {
      const entry: Cached = { at: Date.now(), status: 'not_on_whatsapp', pushName: null, photo: null };
      cache.set(number, entry);
      await log(userId, number, 'not_on_whatsapp', null, false);
      return outcomeOf(number, entry, false);
    }
    // The name and the picture address are independent questions: ask both at once, so a lookup is one round trip long.
    const [pushName, pictureUrl] = await Promise.all([
      openWaPushName(found.waId).catch(() => null),
      openWaProfilePictureUrl(found.waId).catch(() => null),
    ]);
    const photo = pictureUrl ? await downloadProfilePhoto(pictureUrl).catch(() => null) : null;
    const entry: Cached = { at: Date.now(), status: 'on_whatsapp', pushName, photo };
    cache.set(number, entry);
    await log(userId, number, 'on_whatsapp', pushName, false);
    return outcomeOf(number, entry, false);
  } catch (err) {
    const message = err instanceof OpenWaError
      ? (err.code === 'UNREACHABLE' || err.status === 400 || err.status === 409 || err.status === 401 || err.status === 404
        ? `WhatsApp is not connected right now (${err.message}). Nothing was looked up.`
        : err.message)
      : 'The lookup failed. Please try again in a moment.';
    logger.warn({ err }, 'whatsapp lookup failed');
    await log(userId, number, 'disconnected', null, false).catch(() => undefined);
    return { status: 'disconnected', message, number, pushName: null, avatar: null, fromCache: false };
  }
}

// ---------------------------------------------------------------------------
// Which CRM records hold this number
// ---------------------------------------------------------------------------

export interface LookupMatch { id: string; module: 'leads'; name: string }

/** Contacts whose mobile, WhatsApp or alternate number is this one, that this person may open. At most ten. */
export async function recordsWithNumber(ctx: ServiceContext, number: string): Promise<LookupMatch[]> {
  const key = matchKey(number);
  if (!key) return [];
  const present = await columnsOf('ipy_e_leads');
  const sameNumber = ['mobile', 'whatsapp_number', 'alternate_phone']
    .map((column) => `right(regexp_replace(coalesce(${fieldText(present, 'l', column)}, ''), '\\D', '', 'g'), 10) = $1`)
    .join(' OR ');
  const { rows } = await db.query<{ id: string }>(
    `SELECT r.id FROM ipy_record r JOIN ipy_e_leads l ON l.record_id = r.id
      WHERE r.is_deleted = false AND (${sameNumber})
      ORDER BY r.updated_at DESC LIMIT 10`,
    [key],
  );
  const matches: LookupMatch[] = [];
  for (const row of rows) {
    try {
      // The record's own permissions decide: a contact this person cannot open is not shown, nor that it exists.
      const record = await recordService.getRecord(ctx, 'leads', row.id);
      matches.push({ id: row.id, module: 'leads', name: record.label });
    } catch {
      /* not theirs to see */
    }
  }
  return matches;
}

/**
 * The explicit "Save to this record": the name the person chose for themselves and their picture, written as the
 * person pressing the button (so the record's own edit permission applies). Uses what the lookup just found rather
 * than asking WhatsApp a second time.
 */
export async function saveLookupToRecord(
  ctx: ServiceContext, number: string, recordId: string,
): Promise<{ savedName: boolean; savedPhoto: boolean }> {
  const hit = cache.get(number);
  if (!hit || hit.status !== 'on_whatsapp' || Date.now() - hit.at > CACHE_MS) {
    throw new Error('That lookup has expired. Look the number up again, then save.');
  }
  // Only a record this person was shown for this number: the button cannot be pointed at an arbitrary record.
  const allowed = await recordsWithNumber(ctx, number);
  if (!allowed.some((m) => m.id === recordId)) throw new Error('That contact does not have this number.');

  let savedName = false;
  if (hit.pushName) {
    await recordService.updateRecord(ctx, 'leads', recordId, { whatsapp_name: hit.pushName }, { skipWorkflow: true });
    savedName = true;
  }
  const savedPhoto = hit.photo ? (await storeAvatar(recordId, hit.photo, { replace: true })) === 'saved' : false;
  return { savedName, savedPhoto };
}
