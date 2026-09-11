/**
 * Vtiger raw row -> iPropy payload. Every function here is pure — no I/O, no
 * database, no network — so the whole mapping can be unit-tested against
 * real sample rows without touching Vtiger or Postgres. `load.ts` is the
 * only thing that writes.
 *
 * The one exception to "map everything to a field": a value with nowhere
 * structured to go is folded into `qualification_notes` as a labelled line,
 * never silently dropped — see NOTES_ONLY_FIELDS in mapping.ts for why each
 * one landed there rather than getting its own column.
 */
import { parseIndianPrice, splitPhone } from '@ipropy/shared';
import { normaliseDate, DEFAULT_CONTEXT } from '../../core/import/normalise.js';
import { STATUS_MAP, NOTES_ONLY_FIELDS, CONSENT_FIELDS } from './mapping.js';

export type VtigerRow = Record<string, unknown>;

function str(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  return s ? s : undefined;
}

function isoDateTime(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  // Vtiger returns "yyyy-mm-dd hh:mm:ss" for datetime fields — a space, not
  // a "T" — which Date() still parses, but keep it explicit rather than
  // relying on the runtime's leniency.
  const iso = s.includes(' ') && !s.includes('T') ? s.replace(' ', 'T') : s;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Vtiger's `multicurrency` raw value. Never seen live (every sample pulled
 * had this field empty), so this is defensive rather than confirmed: the
 * documented shape is a colon-separated string with the actual entered
 * amount first (`actualvalue::currencyname:convrate:...`). Falls back to
 * running the whole string through the same Indian-price parser the
 * spreadsheet importer uses, so "₹85,00,000" or "85 L" still work if the
 * shape turns out to be simpler than documented. Returns `undefined` rather
 * than 0 on failure — a budget of ₹0 is a claim, not a "couldn't read this".
 */
export function parseVtigerCurrency(raw: unknown): number | undefined {
  const s = str(raw);
  if (!s) return undefined;
  const beforeColons = s.split('::')[0];
  const n = parseIndianPrice(beforeColons ?? s);
  if (n != null) return n;
  const fallback = parseIndianPrice(s);
  return fallback ?? undefined;
}

export interface TransformWarning {
  field: string;
  message: string;
}

export interface TransformResult<T> {
  values: T;
  createdAt?: string;
  updatedAt?: string;
  warnings: TransformWarning[];
  /** New option this row needs on a picklist that doesn't have it yet. */
  newPicklistValues: { picklist: string; value: string }[];
}

// ---------------------------------------------------------------------------
// Contacts -> leads
// ---------------------------------------------------------------------------

export interface LeadTransformOptions {
  /** Existing option sets per iPropy picklist, so a value not already there
   *  is flagged to be added rather than silently coerced to the nearest one. */
  existingPicklistValues: Record<string, Set<string>>;
  resolveOwner: (vtigerUserId: string | undefined) => string | undefined;
}

export function transformContact(
  row: VtigerRow,
  opts: LeadTransformOptions,
): TransformResult<Record<string, unknown>> {
  const warnings: TransformWarning[] = [];
  const newPicklistValues: { picklist: string; value: string }[] = [];

  const checkPicklist = (picklist: string, rawValue: unknown): string | undefined => {
    const value = str(rawValue);
    if (!value) return undefined;
    const known = opts.existingPicklistValues[picklist];
    if (known && !known.has(value)) newPicklistValues.push({ picklist, value });
    return value;
  };

  // This account's name convention is inconsistent about which of the two
  // fields holds the whole name — this formula is correct whichever way a
  // given row did it.
  const fullName = [str(row.firstname), str(row.lastname)].filter(Boolean).join(' ').trim();

  const mobile = splitPhone(str(row.mobile))?.national;
  const altPhone = splitPhone(str(row.otherphone))?.national;

  const statusRaw = str(row.contactstatus);
  let status: string | undefined;
  if (statusRaw) {
    status = STATUS_MAP[statusRaw];
    if (!status) {
      warnings.push({ field: 'contactstatus', message: `unmapped Vtiger stage "${statusRaw}" — needs an entry in STATUS_MAP` });
      status = 'New'; // never leave the mandatory pipeline field unset
    }
  }

  const values: Record<string, unknown> = {
    full_name: fullName || '(no name on record)',
    mobile,
    alternate_phone: altPhone,
    email: str(row.email),
    secondary_email: str(row.secondaryemail),
    status,
    contact_type: checkPicklist('contact_type', row.contacttype),
    lead_source: checkPicklist('lead_source', row.leadsource),
    property_type: checkPicklist('property_type', row.title),
    configuration: (() => {
      const v = checkPicklist('configuration', row.cf_contacts_beds);
      return v ? [v] : undefined;
    })(),
    preferred_locations: (() => {
      const v = checkPicklist('locality', row.happiness_rating);
      return v ? [v] : undefined;
    })(),
    lost_reason: checkPicklist('lost_reason', row.cf_contacts_test4),
    budget: parseVtigerCurrency(row.cf_contacts_budgetdemand),
    next_followup_at: normaliseDate(row.support_end_date, DEFAULT_CONTEXT.dateOrder).value ?? undefined,
    preferred_language: checkPicklist('language', row.language),
    owner_id: opts.resolveOwner(str(row.assigned_user_id)),
  };

  // Property-shaped asides that don't belong on a lead record as structured
  // fields (see NOTES_ONLY_FIELDS in mapping.ts) — folded into one note.
  const noteLines: string[] = [];
  for (const [field, label] of Object.entries(NOTES_ONLY_FIELDS)) {
    const v = str(row[field]);
    if (v) noteLines.push(`${label}: ${v}`);
  }
  if (noteLines.length) {
    values.qualification_notes = noteLines.join('\n');
  }

  if (!mobile && !values.email) {
    warnings.push({ field: 'mobile/email', message: 'row has neither a usable phone nor an email — leads requires one' });
  }

  return {
    values,
    createdAt: isoDateTime(row.createdtime),
    updatedAt: isoDateTime(row.modifiedtime),
    warnings,
    newPicklistValues,
  };
}

/** Everything `transformContact` deliberately didn't map — kept so the raw
 *  row (below) is provably complete, not because this needs calling. */
export const CONSENT_FIELDS_HANDLED_SEPARATELY = CONSENT_FIELDS;

// ---------------------------------------------------------------------------
// ModComments -> ipy_comment
// ---------------------------------------------------------------------------

export function transformNote(row: VtigerRow): {
  body: string;
  createdAt?: string;
  isPrivate: boolean;
  relatedVtigerId: string | undefined;
  vtigerUserId: string | undefined;
} | null {
  const body = str(row.commentcontent);
  if (!body) return null;
  return {
    body,
    createdAt: isoDateTime(row.createdtime),
    isPrivate: row.is_private === '1' || row.is_private === true,
    relatedVtigerId: str(row.related_to),
    vtigerUserId: str(row.creator) ?? str(row.userid),
  };
}

// ---------------------------------------------------------------------------
// Calendar (tasks) and Events (meetings) -> ipy_comment
//
// iPropy has deliberately no generic Activity/Task module (CLAUDE.md: "a
// follow-up is a date on the record, not a task record"). Historical tasks
// and meetings have no structured home that means the same thing, so they
// become timeline notes rather than distorted into a field that means
// something narrower than what actually happened.
// ---------------------------------------------------------------------------

function formatWhen(row: VtigerRow): string {
  const date = str(row.date_start) ?? str(row.due_date);
  const time = str(row.time_start);
  return [date, time].filter(Boolean).join(' ');
}

export function transformTask(row: VtigerRow): {
  body: string;
  createdAt?: string;
  relatedVtigerId: string | undefined;
} | null {
  const subject = str(row.subject);
  if (!subject) return null;
  const lines = [`[Task] ${subject}`];
  const when = formatWhen(row);
  if (when) lines.push(`When: ${when}`);
  if (str(row.taskstatus)) lines.push(`Status: ${row.taskstatus}`);
  if (str(row.description)) lines.push(String(row.description));
  return {
    body: lines.join('\n'),
    createdAt: isoDateTime(row.createdtime),
    relatedVtigerId: str(row.contact_id),
  };
}

export function transformMeeting(row: VtigerRow): {
  body: string;
  createdAt?: string;
  relatedVtigerId: string | undefined;
} | null {
  const subject = str(row.subject);
  if (!subject) return null;
  const lines = [`[Meeting] ${subject}`];
  const when = formatWhen(row);
  if (when) lines.push(`When: ${when}`);
  if (str(row.location)) lines.push(`Location: ${row.location}`);
  if (str(row.checkin_datetime)) {
    lines.push(`Checked in: ${row.checkin_datetime}${row.actual_checkedin_location ? ` at ${row.actual_checkedin_location}` : ''}`);
  }
  if (str(row.meeting_notes)) lines.push(String(row.meeting_notes));
  else if (str(row.description)) lines.push(String(row.description));
  return {
    body: lines.join('\n'),
    createdAt: isoDateTime(row.createdtime),
    relatedVtigerId: str(row.contact_id),
  };
}

// ---------------------------------------------------------------------------
// Emails -> ipy_email_log
// ---------------------------------------------------------------------------

export function transformEmail(row: VtigerRow): {
  subject?: string;
  bodyHtml?: string;
  fromAddress?: string;
  toAddresses: string[];
  ccAddresses: string[];
  bccAddresses: string[];
  createdAt?: string;
  relatedVtigerId: string | undefined;
  relatedType: string | undefined;
} | null {
  if (str(row.parent_type) !== 'Contacts') return null; // only what's linked to a contact carries through
  const splitAddrs = (v: unknown): string[] => (str(v) ?? '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  return {
    subject: str(row.subject),
    bodyHtml: str(row.description),
    fromAddress: str(row.from_email),
    toAddresses: splitAddrs(row.saved_toid),
    ccAddresses: splitAddrs(row.ccmail),
    bccAddresses: splitAddrs(row.bccmail),
    createdAt: isoDateTime(row.createdtime) ?? isoDateTime(row.date_start),
    relatedVtigerId: str(row.parent_id),
    relatedType: str(row.parent_type),
  };
}

// ---------------------------------------------------------------------------
// PhoneCalls -> ipy_call. This account has zero today — built anyway so a
// module that gains rows later (or a different account) is covered without
// a second pass.
// ---------------------------------------------------------------------------

export function transformCall(row: VtigerRow): {
  direction: 'inbound' | 'outbound' | 'missed';
  fromNumber: string;
  toNumber: string;
  durationSeconds: number;
  recordingUrl?: string;
  transcript?: string;
  notes?: string;
  startedAt?: string;
  endedAt?: string;
  relatedVtigerId: string | undefined;
  relatedType: string | undefined;
} | null {
  if (str(row.customertype) !== 'Contacts') return null;
  const number = str(row.customernumber) ?? '';
  const dirRaw = str(row.direction)?.toLowerCase();
  const direction = dirRaw === 'inbound' ? 'inbound' : dirRaw === 'outbound' ? 'outbound' : 'missed';
  return {
    direction,
    fromNumber: direction === 'inbound' ? number : 'unknown',
    toNumber: direction === 'inbound' ? 'unknown' : number,
    durationSeconds: Number(row.totalduration) || 0,
    recordingUrl: str(row.recordingurl),
    transcript: str(row.transcription),
    notes: str(row.notes),
    startedAt: isoDateTime(row.starttime),
    endedAt: isoDateTime(row.endtime),
    relatedVtigerId: str(row.customer),
    relatedType: str(row.customertype),
  };
}
