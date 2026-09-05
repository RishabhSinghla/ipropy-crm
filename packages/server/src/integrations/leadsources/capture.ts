/**
 * Lead capture from every inbound source.
 *
 * Each source has a small normaliser that maps its payload onto CRM fields;
 * everything then flows through one `captureLead` path that handles dedupe,
 * attribution, assignment and SLA start. Raw payloads are always stored first
 * so a mapping bug never loses a lead.
 */
import { type AuthUser, evaluateFilter, splitPhone, toE164 } from '@ipropy/shared';
import { db, type Tx } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { bus } from '../../core/events/bus.js';
import { createRecord, updateRecord, type ServiceContext } from '../../core/entity/recordService.js';
import { assignOwner } from '../../core/workflow/assignment.js';
import { notify } from '../../core/notifications/index.js';

const SYSTEM_USER: AuthUser = {
  id: '00000000-0000-0000-0000-000000000000',
  email: 'system@ipropy', firstName: 'iPropy', lastName: 'Capture',
  fullName: 'iPropy Capture', avatarUrl: null, phone: null,
  isAdmin: true, isActive: true, roleId: null, roleName: null,
  profileId: null, profileName: null, groupIds: [],
  timezone: 'Asia/Kolkata', locale: 'en-IN', currency: 'INR',
  theme: 'system', defaultDashboardId: null, extension: null, lastLoginAt: null,
};

function systemContext(): ServiceContext {
  return { user: SYSTEM_USER, subordinateIds: [], groupIds: [], system: true, source: 'lead_capture' };
}

export interface NormalizedLead {
  firstName: string;
  lastName?: string;
  email?: string;
  mobile?: string;
  source: string;
  subSource?: string;
  message?: string;
  projectName?: string;
  configuration?: string[];
  budgetMin?: number;
  budgetMax?: number;
  locations?: string[];
  timeline?: string;
  purpose?: string;
  utm?: Record<string, string>;
  landingPage?: string;
  ipAddress?: string;
  externalId?: string;
  extra?: Record<string, unknown>;
}

export interface CaptureResult {
  status: 'created' | 'duplicate' | 'failed';
  recordId: string | null;
  message?: string;
}

/**
 * Store the raw payload, normalise, dedupe, create, assign, start the SLA.
 */
export async function captureLead(
  source: string,
  raw: unknown,
  normalized: NormalizedLead,
  opts: { externalId?: string; ownerId?: string; assignRuleId?: string; createdBy?: AuthUser } = {},
): Promise<CaptureResult> {
  const inbox = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_lead_inbox (source, external_id, raw_payload, normalized)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      source,
      opts.externalId ?? normalized.externalId ?? submissionFingerprint(source, normalized),
      JSON.stringify(raw), JSON.stringify(normalized),
    ],
  );

  // A conflict means we've already processed this exact submission.
  if (!inbox) {
    logger.debug({ source, externalId: opts.externalId }, 'lead already captured — ignoring replay');
    return { status: 'duplicate', recordId: null, message: 'Already captured' };
  }

  try {
    const mobile = normalized.mobile ? toE164(normalized.mobile) : null;

    // The module keeps the country code and the national number in separate
    // fields, with a per-country digit count — so the E.164 string every source
    // hands over ("+919812345671") fails `mobile` outright with "must be
    // exactly 10 digits". Splitting is the other half of the migration-026
    // breakage that lost every inbound enquiry.
    const parts = splitPhone(normalized.mobile);

    // Dedupe against recent leads on the same number/email.
    const windowDays = await getSetting<number>('leads.duplicate_window_days', 90);
    const existing = await findRecentLead(mobile, normalized.email, windowDays);

    if (existing) {
      await enrichExistingLead(existing.record_id, normalized);
      await db.query(
        `UPDATE ipy_lead_inbox SET status = 'duplicate', record_id = $2, processed_at = now() WHERE id = $1`,
        [inbox.id, existing.record_id],
      );
      return { status: 'duplicate', recordId: existing.record_id, message: 'Merged into the existing enquiry' };
    }

    const values: Record<string, unknown> = {
      // One name field, not two.
      //
      // Leads carried `first_name`/`last_name` until migration 026 merged them
      // into a single mandatory `full_name`; every source that feeds this
      // function kept writing the old pair. Unknown keys are ignored rather
      // than rejected, so `full_name` simply arrived empty and validation
      // refused the record — and because the web form answers 200 with its
      // success message regardless, a visitor saw "our team will call you
      // shortly" while nothing was created.
      //
      // This is the single write path for *every* automated source — the
      // website form, Facebook lead ads, Google Ads, the portal webhooks and
      // email-to-lead — so the whole top of the funnel was silently dropping
      // enquiries. `ipy_lead_inbox` recorded each one as `failed` with
      // "Full Name is required", which is the only reason it was findable.
      //
      // The `firstName`/`lastName` split stays on NormalizedLead: the source
      // adapters genuinely receive names both ways, and joining here is the one
      // place that has to know what the module currently looks like.
      full_name: [normalized.firstName, normalized.lastName]
        .map((part) => (part ?? '').trim())
        .filter(Boolean)
        .join(' ') || 'Unknown',
      email: normalized.email ?? null,
      // The national digits only. Every lead this business takes is an Indian
      // mobile (migration 064), so a number arriving with a foreign code keeps
      // its own digits here and fails the ten-digit rule loudly in the lead
      // inbox rather than being filed as an Indian number it is not.
      mobile: parts?.national ?? null,
      // Keeps its full dialable form: this is what a wa.me link and the Cloud
      // API actually send to, and it has no per-country length rule.
      whatsapp_number: mobile,
      status: 'New',
      lead_source: normalized.source,
      sub_source: normalized.subSource ?? null,
      interested_project: normalized.projectName ?? null,
      configuration: normalized.configuration ?? [],
      preferred_locations: normalized.locations ?? [],
      budget: normalized.budgetMax ?? normalized.budgetMin ?? null,
      possession_timeline: normalized.timeline ?? null,
      purpose: normalized.purpose ?? null,
      utm_source: normalized.utm?.utm_source ?? null,
      utm_medium: normalized.utm?.utm_medium ?? null,
      utm_campaign: normalized.utm?.utm_campaign ?? null,
      utm_term: normalized.utm?.utm_term ?? null,
      utm_content: normalized.utm?.utm_content ?? null,
      gclid: normalized.utm?.gclid ?? null,
      fbclid: normalized.utm?.fbclid ?? null,
      landing_page: normalized.landingPage ?? null,
      ip_address: normalized.ipAddress ?? null,
      description: normalized.message ?? null,
      ...(normalized.extra ?? {}),
    };

    // Owner: explicit → assignment rules → unassigned (a manager picks it up).
    let ownerId = opts.ownerId ?? null;
    if (!ownerId && await getSetting('leads.auto_assign', true)) {
      ownerId = await assignOwner('leads', values);
    }
    values.owner_id = ownerId;

    const ctx = opts.createdBy
      ? { user: opts.createdBy, subordinateIds: [], groupIds: [], system: true, source: 'lead_capture' }
      : systemContext();
    const record = await createRecord(ctx, 'leads', values, { skipDuplicateCheck: true });

    await db.query(
      `UPDATE ipy_lead_inbox SET status = 'processed', record_id = $2, processed_at = now() WHERE id = $1`,
      [inbox.id, record.id],
    );

    await startSla(record.id, record.values);

    bus.emitAsync('lead.captured', { recordId: record.id, source, raw });

    logger.info({ source, recordId: record.id, ownerId }, 'lead captured');
    return { status: 'created', recordId: record.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, source }, 'lead capture failed');
    await db.query(
      `UPDATE ipy_lead_inbox SET status = 'failed', error = $2, processed_at = now() WHERE id = $1`,
      [inbox.id, message],
    );
    return { status: 'failed', recordId: null, message };
  }
}

async function findRecentLead(
  mobile: string | null,
  email: string | undefined,
  windowDays: number,
  conn: Tx = db,
): Promise<{ record_id: string } | null> {
  if (!mobile && !email) return null;
  const tail = mobile ? mobile.replace(/\D/g, '').slice(-10) : null;
  return conn.queryOne<{ record_id: string }>(
    `SELECT l.record_id FROM ipy_e_leads l
     JOIN ipy_record r ON r.id = l.record_id
     WHERE r.is_deleted = false
       AND l.is_converted = false
       AND r.created_at > now() - ($3 || ' days')::interval
       AND (
         ($1::text IS NOT NULL AND right(regexp_replace(COALESCE(l.mobile,''), '\\D','','g'), 10) = $1)
         OR ($2::text IS NOT NULL AND lower(l.email) = lower($2))
       )
     ORDER BY r.created_at DESC LIMIT 1`,
    [tail, email ?? null, windowDays],
  );
}

/** A repeat enquiry is a buying signal — record it rather than discarding it. */
async function enrichExistingLead(recordId: string, normalized: NormalizedLead): Promise<void> {
  const updates: Record<string, unknown> = {};
  const current = await db.queryOne<{ email: string | null; budget: number | null; description: string | null; contact_attempts: number }>(
    `SELECT email, budget, description, contact_attempts FROM ipy_e_leads WHERE record_id = $1`,
    [recordId],
  );

  if (!current?.email && normalized.email) updates.email = normalized.email;
  if (!current?.budget && normalized.budgetMax) updates.budget = normalized.budgetMax ?? normalized.budgetMin;

  const note = `[Repeat enquiry ${new Date().toLocaleDateString('en-IN')} via ${normalized.source}]${
    normalized.message ? ` ${normalized.message}` : ''}`;
  updates.description = current?.description ? `${current.description}\n${note}` : note;

  await updateRecord(systemContext(), 'leads', recordId, updates, { skipDuplicateCheck: true });

  /*
    Put the enquiry on the timeline, not only in the notes box.

    The line above was the only record that somebody had come back, and it was
    being thrown away. `description` is switched off on this CRM, so
    `recordService` strips it — and when the email and budget are already filled
    it is the *only* change, which leaves an empty change set, and an empty
    change set skips the write, the audit row and the timeline entry together.
    Somebody could enquire three times and the CRM would show one enquiry.

    That is the strongest buying signal there is, so it goes somewhere that does
    not depend on a field an admin can hide. A repeat enquiry is also genuinely
    an event rather than a property of the person, which is what the timeline is
    for.

    Deliberately after the update and outside it: failing to file the note must
    never cost the email or budget that came with the enquiry.
  */
  try {
    const owner = await db.queryOne<{ owner_id: string | null }>(
      `SELECT owner_id FROM ipy_record WHERE id = $1`, [recordId],
    );
    if (owner?.owner_id) {
      await db.query(
        `INSERT INTO ipy_comment (record_id, user_id, body) VALUES ($1,$2,$3)`,
        [recordId, owner.owner_id, note],
      );
    }
  } catch (err) {
    logger.warn({ err, recordId }, 'could not file the repeat enquiry on the timeline');
  }

  const record = await db.queryOne<{ label: string; owner_id: string | null }>(
    `SELECT label, owner_id FROM ipy_record WHERE id = $1`,
    [recordId],
  );
  // Somebody enquiring a second time is the strongest signal this CRM sees, and
  // it arrives while the rep is out. Worth a push, not just a row.
  if (record?.owner_id) {
    await notify({
      userId: record.owner_id,
      kind: 'repeat_enquiry',
      title: 'Repeat enquiry received',
      body: `${record.label} enquired again via ${normalized.source}`,
      link: `/leads/${recordId}`,
      recordId,
    });
  }
}

/** Start the SLA clock using the first matching policy. */
async function startSla(recordId: string, values: Record<string, unknown>): Promise<void> {
  const policies = await db.query<{ id: string; conditions: never; first_response_minutes: number | null; resolution_minutes: number | null }>(
    `SELECT sp.id, sp.conditions, sp.first_response_minutes, sp.resolution_minutes
     FROM ipy_sla_policy sp JOIN ipy_module m ON m.id = sp.module_id
     WHERE m.name = 'leads' AND sp.is_active ORDER BY sp.created_at`,
  );

  for (const p of policies.rows) {
    if (!evaluateFilter(p.conditions, values)) continue;
    await db.query(
      `INSERT INTO ipy_sla_tracker (record_id, policy_id, first_response_due, resolution_due)
       VALUES ($1,$2,
         CASE WHEN $3::int IS NULL THEN NULL ELSE now() + ($3 || ' minutes')::interval END,
         CASE WHEN $4::int IS NULL THEN NULL ELSE now() + ($4 || ' minutes')::interval END)
       ON CONFLICT (record_id) DO NOTHING`,
      [recordId, p.id, p.first_response_minutes, p.resolution_minutes],
    );
    return;
  }
}

async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await db.queryOne<{ value: T }>(`SELECT value FROM ipy_setting WHERE key = $1`, [key]);
  return row?.value ?? fallback;
}

// ---------------------------------------------------------------------------
// Source-specific normalisers
// ---------------------------------------------------------------------------

/** Facebook Lead Ads — field_data is an array of {name, values[]}. */
export function normalizeFacebook(payload: {
  field_data?: { name: string; values: string[] }[];
  form_id?: string;
  campaign_id?: string;
  campaign_name?: string;
  leadgen_id?: string;
  ad_id?: string;
}): NormalizedLead {
  const fields = new Map(
    (payload.field_data ?? []).map((f) => [f.name.toLowerCase(), f.values?.[0] ?? '']),
  );
  const fullName = fields.get('full_name') ?? fields.get('name') ?? '';
  const [firstName, ...rest] = fullName.split(/\s+/);

  return {
    firstName: fields.get('first_name') ?? firstName ?? 'Facebook',
    lastName: fields.get('last_name') ?? rest.join(' '),
    email: fields.get('email'),
    mobile: fields.get('phone_number') ?? fields.get('phone'),
    source: 'Facebook Lead Ad',
    subSource: 'Paid',
    projectName: fields.get('project') ?? fields.get('property_interested'),
    message: fields.get('message') ?? fields.get('comments'),
    budgetMax: parseBudget(fields.get('budget')),
    timeline: fields.get('when_are_you_planning_to_buy') ?? fields.get('timeline'),
    externalId: payload.leadgen_id,
    // The ad platform's own campaign name (or its id) is the attribution — it
    // lands in `utm_campaign` on the lead, which is where reporting reads it.
    utm: {
      utm_source: 'facebook', utm_medium: 'paid_social',
      utm_campaign: payload.campaign_name ?? payload.campaign_id ?? '',
    },
  };
}

/** Google Ads lead form extension. */
export function normalizeGoogleAds(payload: {
  user_column_data?: { column_id: string; string_value: string }[];
  campaign_id?: string;
  lead_id?: string;
  gcl_id?: string;
}): NormalizedLead {
  const fields = new Map(
    (payload.user_column_data ?? []).map((c) => [c.column_id.toUpperCase(), c.string_value]),
  );
  const fullName = fields.get('FULL_NAME') ?? '';
  const [firstName, ...rest] = fullName.split(/\s+/);

  return {
    firstName: fields.get('FIRST_NAME') ?? firstName ?? 'Google',
    lastName: fields.get('LAST_NAME') ?? rest.join(' '),
    email: fields.get('EMAIL'),
    mobile: fields.get('PHONE_NUMBER'),
    source: 'Google Ads',
    subSource: 'Paid',
    externalId: payload.lead_id,
    utm: {
      utm_source: 'google', utm_medium: 'cpc', gclid: payload.gcl_id ?? '',
      utm_campaign: payload.campaign_id ?? '',
    },
  };
}

/** Property portals (99acres / MagicBricks / Housing / NoBroker). */
export function normalizePortal(source: string, payload: Record<string, unknown>): NormalizedLead {
  const get = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = payload[k] ?? payload[k.toLowerCase()] ?? payload[k.toUpperCase()];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v);
    }
    return undefined;
  };

  const fullName = get('name', 'Name', 'customer_name', 'senderName', 'buyer_name') ?? '';
  const [firstName, ...rest] = fullName.split(/\s+/);

  return {
    firstName: firstName || source,
    lastName: rest.join(' '),
    email: get('email', 'Email', 'senderEmail', 'buyer_email'),
    mobile: get('phone', 'mobile', 'Phone', 'senderPhone', 'contact_number', 'buyer_phone'),
    source,
    // 'Portal' is not a value this picklist has ever offered — it holds
    // Organic / Paid / Retargeting / … — so every 99acres, MagicBricks and
    // Housing lead was refused with "Sub Source must be one of: …" and lost.
    // Which portal it was is already recorded in `lead_source`; what
    // `sub_source` is actually for is the paid-vs-organic split that drives
    // campaign ROI, and a portal listing is bought, exactly like the Google and
    // Facebook adapters above.
    subSource: 'Paid',
    projectName: get('project', 'projectName', 'property_name', 'listing_title'),
    message: get('message', 'query', 'comments', 'requirement'),
    locations: [get('locality', 'location', 'city')].filter(Boolean) as string[],
    budgetMax: parseBudget(get('budget', 'max_budget', 'budget_range')),
    configuration: [get('bhk', 'configuration', 'property_type')].filter(Boolean) as string[],
    externalId: get('lead_id', 'leadId', 'id', 'enquiry_id'),
  };
}

function parseBudget(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/[₹,\s]/gi, '').toLowerCase();
  // Ranges like "50L-75L" — take the upper bound as the ceiling.
  const range = cleaned.match(/([\d.]+)\s*(cr|crore|l|lac|lakh)?\s*[-–to]+\s*([\d.]+)\s*(cr|crore|l|lac|lakh)?/);
  if (range) return toRupees(range[3], range[4] ?? range[2]);
  const single = cleaned.match(/([\d.]+)\s*(cr|crore|l|lac|lakh|k)?/);
  if (single) return toRupees(single[1], single[2]);
  return undefined;
}

function toRupees(num: string, unit?: string): number | undefined {
  const n = Number(num);
  if (!Number.isFinite(n)) return undefined;
  switch (unit) {
    case 'cr': case 'crore': return n * 10_000_000;
    case 'l': case 'lac': case 'lakh': return n * 100_000;
    case 'k': return n * 1000;
    default: return n > 10_000 ? n : n * 100_000; // bare small numbers read as lakhs
  }
}


/**
 * How long two identical submissions count as the same one.
 *
 * Only long enough to cover a retry or a double tap. A genuine second enquiry
 * from the same person minutes later must get its own inbox row so it reaches
 * `findRecentLead` and enriches the existing lead — being told "already
 * captured" and dropped would lose the very signal a repeat enquiry carries.
 */
const REPLAY_WINDOW_SECONDS = 120;

/**
 * An identity for a submission that arrived without one.
 *
 * Sources that carry their own `external_id` — the portals, Facebook, Google —
 * have always been safe here, because the insert above has a unique constraint
 * to land on. The website form carries nothing, so two submissions arriving
 * together both passed the dedupe SELECT and both created a lead. Measured: six
 * simultaneous posts of one enquiry produced six leads, six owners and, once
 * WhatsApp is live, six welcome messages to the same buyer. A visitor
 * double-tapping Submit on a slow phone is the ordinary case, not a
 * hypothetical.
 *
 * The first attempt at this was `pg_advisory_xact_lock`, which does nothing
 * outside an explicit transaction — the lock released the instant its own
 * statement committed, before the check it was meant to protect. Wrapping the
 * whole capture in a transaction would have worked and would also have put
 * record creation, assignment and event emission inside one, which is the
 * deadlock this codebase already has a rule about.
 *
 * So the submission gets an identity instead, and the constraint that already
 * exists does the work. The time bucket is what keeps a real repeat enquiry
 * distinguishable from a replay; two posts straddling a bucket boundary can
 * still both land, which turns "always duplicated" into "duplicated if two
 * requests are seconds apart *and* fall either side of a two-minute line".
 */
function submissionFingerprint(source: string, normalized: NormalizedLead): string {
  const identity = (normalized.mobile ?? normalized.email ?? normalized.firstName ?? '')
    .trim().toLowerCase();
  if (!identity) return `${source}:anonymous:${Date.now()}`;
  const bucket = Math.floor(Date.now() / (REPLAY_WINDOW_SECONDS * 1000));
  return `${source}:${identity}:${bucket}`;
}
