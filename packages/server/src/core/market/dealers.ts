/**
 * The people who post in the dealer groups, as Associates.
 *
 * Everything that comes out of WhatsApp lands in the Associates module and
 * nothing goes to Contacts or Inventory (the owner's rule, 12 October 2026):
 * these groups hold dealers and builders, not our buyers and sellers, and a
 * dealer in the Contacts list is a dealer a rep will ring as if they were a
 * lead. A dealer is found by the number in their post; one number is one
 * person, which is also what the CRM's own mobile rule enforces.
 *
 * Nothing is invented. A dealer whose posts name no locality the business
 * knows is left out and counted — Associates requires a location, and a guess
 * there is a wrong record in a live CRM, which is worse than a missing one.
 */
import { db } from '../../db/pool.js';
import { registry } from '../metadata/registry.js';
import { createRecord } from '../entity/recordService.js';
import { systemContext } from '../../integrations/leadsources/capture.js';
import { ConflictError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

export interface Dealer {
  phone: string;
  name: string | null;
  posts: number;
  haves: number;
  wants: number;
  groups: string[];
  /** The business's own locality names this dealer posts about, most-mentioned first. */
  localities: string[];
  /** What they mostly post about, in the categories Jev answers in. */
  category: string | null;
  /** A second number the dealer's posts give, usually a partner or the office. */
  altPhone: string | null;
  lastSeenAt: string | null;
}

const FIRM_WORDS = /\b(associates?|realtors?|properties|property|estates?|builders?|developers?|infra|realty|consultants?|enterprises?|agency|group|constructions?|homes?|buildcon|land)\b/i;
const BUILDER_WORDS = /\b(builders?|developers?|infra|buildcon|constructions?)\b/i;

export function looksLikeAFirm(name: string | null): boolean {
  return !!name && FIRM_WORDS.test(name);
}

/** A sender WhatsApp could not name is shown by its number; that is not a name to keep. */
export function usableName(name: string | null): string | null {
  const trimmed = (name ?? '').trim();
  if (!trimmed || /^[+\d\s()-]+$/.test(trimmed)) return null;
  return trimmed;
}

export async function dealerDirectory(minPosts = 1): Promise<Dealer[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT poster_phone AS phone,
            (array_agg(poster_name ORDER BY seen_count DESC) FILTER (WHERE poster_name IS NOT NULL))[1] AS name,
            count(*)::int AS posts,
            count(*) FILTER (WHERE kind = 'have')::int AS haves,
            count(*) FILTER (WHERE kind = 'want')::int AS wants,
            mode() WITHIN GROUP (ORDER BY category) AS category,
            array_agg(DISTINCT g) AS groups,
            max(coalesce(last_posted_at, created_at)) AS last_seen
       FROM ipy_market_post, unnest(groups) AS g
      WHERE poster_phone IS NOT NULL AND NOT is_noise
      GROUP BY poster_phone
     HAVING count(DISTINCT id) >= $1
      ORDER BY count(*) DESC`,
    [minPosts],
  );
  const places = await db.query<{ phone: string; locality: string }>(
    `SELECT poster_phone AS phone, l AS locality
       FROM ipy_market_post, unnest(localities || places) AS l
      WHERE poster_phone IS NOT NULL AND NOT is_noise
      GROUP BY poster_phone, l ORDER BY count(*) DESC`,
  );
  const alts = await db.query<{ phone: string; alt: string }>(
    `SELECT DISTINCT ON (poster_phone) poster_phone AS phone, ph AS alt
       FROM ipy_market_post, unnest(phones) AS ph
      WHERE poster_phone IS NOT NULL AND ph <> poster_phone AND NOT is_noise
      GROUP BY poster_phone, ph ORDER BY poster_phone, count(*) DESC`,
  );
  const altByPhone = new Map(alts.rows.map((row) => [row.phone, row.alt]));
  const localitiesByPhone = new Map<string, string[]>();
  for (const row of places.rows) localitiesByPhone.set(row.phone, [...(localitiesByPhone.get(row.phone) ?? []), row.locality]);

  return rows.rows.map((row) => ({
    phone: row.phone as string,
    name: row.name as string | null,
    posts: row.posts as number,
    haves: row.haves as number,
    wants: row.wants as number,
    groups: row.groups as string[],
    localities: localitiesByPhone.get(row.phone as string) ?? [],
    category: row.category as string | null,
    altPhone: altByPhone.get(row.phone as string) ?? null,
    lastSeenAt: row.last_seen ? new Date(row.last_seen as string).toISOString() : null,
  }));
}

export interface AssociateOutcome {
  created: number;
  /** The number already belongs to a record in Contacts, Inventory or Associates. */
  alreadyKnown: number;
  /** No locality the business knows; not guessed. */
  noLocation: number;
  /** The CRM refused the record for some other reason. */
  refused: number;
  /** Why the first refused record was refused, so a dead feature says so instead of reading as success. */
  firstRefusal: string | null;
  /** This database has no Associates module (a fresh install), so nothing was written. */
  noModule: boolean;
}

/** What the module says about one of its own fields: whether it takes several values, and which. */
export interface FieldInfo {
  multi: boolean;
  /** lower-cased → as the field writes it, in the field's own order. Null when it is free text. */
  options: Map<string, string> | null;
}

/**
 * The first wanted value this field accepts, as the field spells it. A free-text
 * field takes the first one as given; a dropdown takes only what it lists, so
 * "Dealer" becomes "Broker" where that is what this module calls it, and
 * nothing at all where there is no fit — never a value the CRM would refuse.
 */
function pick(info: FieldInfo | undefined, ...wanted: Array<string | null | undefined>): string | undefined {
  if (!info) return undefined;
  for (const value of wanted) {
    if (!value) continue;
    if (!info.options) return value;
    const hit = info.options.get(value.toLowerCase());
    if (hit) return hit;
  }
  return undefined;
}

/** The values for one dealer, using only fields the module really has. Pure for its test. */
export function associateValues(dealer: Dealer, fields: Map<string, FieldInfo>): Record<string, unknown> | null {
  const location = fields.get('preferred_locations');
  // A sector appears as both a locality and a place key, and both land on the same option.
  const locations = [...new Set(dealer.localities.map((place) => pick(location, place)).filter((place): place is string => !!place))];
  if (!locations.length) return null;
  const name = usableName(dealer.name);

  const values: Record<string, unknown> = {
    full_name: name ?? `WhatsApp ${dealer.phone}`,
    mobile: dealer.phone,
    preferred_locations: location?.multi ? locations.slice(0, 5) : locations[0],
  };
  // The status field is `associate_status` where the module was designed and `status` where it was cloned from Leads.
  const statusName = fields.has('associate_status') ? 'associate_status' : 'status';
  const status = fields.get(statusName);
  const optional: Record<string, string | undefined> = {
    contact_type: pick(fields.get('contact_type'), BUILDER_WORDS.test(name ?? '') ? 'Builder' : 'Dealer', 'Dealer', 'Broker'),
    [statusName]: pick(status, 'New') ?? (status?.options ? [...status.options.values()][0] : undefined),
    category: pick(fields.get('category'), dealer.category, 'Unknown'),
    company: looksLikeAFirm(name) ? pick(fields.get('company'), name) : undefined,
    source: pick(fields.get('source'), 'WhatsApp'),
    alternate_phone: fields.has('alternate_phone') && dealer.altPhone && dealer.altPhone !== dealer.phone ? dealer.altPhone : undefined,
  };
  for (const [field, value] of Object.entries(optional)) {
    if (value !== undefined) values[field] = value;
  }
  return values;
}

function fieldInfoOf(field: { uitype: string; options?: Array<{ value: string; label?: string; isActive?: boolean }> }): FieldInfo {
  const options = (field.options ?? []).filter((option) => option.isActive !== false);
  return {
    multi: field.uitype === 'multipicklist',
    options: options.length
      ? new Map(options.flatMap((option) => [[option.value.toLowerCase(), option.value], [(option.label ?? '').toLowerCase(), option.value]] as const).filter(([key]) => key))
      : null,
  };
}

export async function saveDealersAsAssociates(dealers: Dealer[]): Promise<AssociateOutcome> {
  const outcome: AssociateOutcome = { created: 0, alreadyKnown: 0, noLocation: 0, refused: 0, firstRefusal: null, noModule: false };
  const module = await registry.getModule('associates');
  if (!module || !module.isActive) return { ...outcome, noModule: true };

  const fields = new Map(module.fields.filter((field) => field.isActive).map((field) => [field.name, fieldInfoOf(field)] as const));
  const ctx = { ...systemContext(), source: 'market_feed' };

  for (const dealer of dealers) {
    const values = associateValues(dealer, fields);
    if (!values) { outcome.noLocation += 1; continue; }
    try {
      try {
        await createRecord(ctx, 'associates', values);
      } catch (err) {
        // The second number may already belong to somebody else; the dealer is still worth having without it.
        if (!(err instanceof ConflictError) || !values.alternate_phone) throw err;
        const { alternate_phone: _dropped, ...withoutAlternate } = values;
        await createRecord(ctx, 'associates', withoutAlternate);
      }
      outcome.created += 1;
    } catch (err) {
      if (err instanceof ConflictError) { outcome.alreadyKnown += 1; continue; }
      outcome.refused += 1;
      outcome.firstRefusal ??= err instanceof Error ? err.message : String(err);
      logger.warn({ err, phone: dealer.phone }, 'market: an Associate was refused');
    }
  }
  return outcome;
}
