/**
 * Turning CRM records into something a model reads well.
 *
 * The API answers with everything: sixty fields per lead, most of them null,
 * plus display strings, permissions and metadata. Handing that straight to a
 * model is expensive and, worse, it buries the four facts that matter under
 * fifty-six that do not — which is how you get an assistant that summarises a
 * lead by reciting its KYC status.
 *
 * So each tool decides what a person would actually want to hear, and this
 * renders it as plain lines. Text, not JSON: a model reads "Budget: ₹1.8–2.4
 * Cr" more reliably than `{"budget_min":18000000,...}`, and the reader
 * downstream is a person, not a parser.
 */

export interface RecordEnvelope {
  id: string;
  label: string;
  recordNumber?: string | null;
  values: Record<string, unknown>;
  display?: Record<string, string> | null;
}

/** ₹1.85 Cr / ₹42 L — how prices are said and written in Indian real estate. */
export function indianPrice(value: unknown): string | null {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n === 0) return null;
  if (Math.abs(n) >= 10_000_000) return `₹${trim(n / 10_000_000)} Cr`;
  if (Math.abs(n) >= 100_000) return `₹${trim(n / 100_000)} L`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

function trim(n: number): string {
  return n.toFixed(2).replace(/\.?0+$/, '');
}

/** A budget range from its two ends, either of which may be missing. */
export function budgetRange(min: unknown, max: unknown): string | null {
  const lo = indianPrice(min);
  const hi = indianPrice(max);
  if (lo && hi) return `${lo}–${hi}`;
  if (hi) return `up to ${hi}`;
  if (lo) return `${lo}+`;
  return null;
}

export function asDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Join what is actually there, dropping the rest. Order is the caller's. */
export function lines(pairs: [string, unknown][]): string {
  return pairs
    .filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
    .join('\n');
}

/**
 * A lead in the shape a rep would describe one: who, how to reach them, what
 * they want, and what happens next.
 */
export function leadSummary(row: RecordEnvelope, opts: { full?: boolean } = {}): string {
  const v = row.values;
  const d = row.display ?? {};
  const head = `${row.label}${row.recordNumber ? ` (${row.recordNumber})` : ''}`;

  const core: [string, unknown][] = [
    ['Mobile', phone(v)],
    ['Stage', d.lifecycle_stage ?? v.lifecycle_stage],
    ['Status', d.status ?? v.status],
    ['Budget', budgetRange(v.budget_min, v.budget_max)],
    ['Wants', v.configuration],
    ['Preferred areas', v.preferred_locations],
    ['Interested in', d.interested_project ?? v.interested_project],
    ['Next follow-up', asDate(v.next_followup_at)],
    ['Owner', d.owner_id],
    ['AI score', v.ai_score],
  ];

  if (!opts.full) return `${head}\n${lines(core)}`;

  return `${head}\n${lines([
    ...core,
    ['Email', v.email],
    ['Source', d.lead_source ?? v.lead_source],
    ['Timeline', d.possession_timeline ?? v.possession_timeline],
    ['Purpose', d.purpose ?? v.purpose],
    ['Funding', d.funding_type ?? v.funding_type],
    ['Last contacted', asDate(v.last_contacted_at)],
    ['Notes', v.description],
  ])}`;
}

/** A unit as a buyer would be told about it. */
export function propertySummary(row: RecordEnvelope, opts: { full?: boolean } = {}): string {
  const v = row.values;
  const d = row.display ?? {};
  const head = `${row.label}${row.recordNumber ? ` (${row.recordNumber})` : ''}`;

  const core: [string, unknown][] = [
    ['Status', d.status ?? v.status],
    ['Configuration', d.configuration ?? v.configuration],
    ['Price', indianPrice(v.total_price ?? v.base_price)],
    ['Carpet area', v.carpet_area ? `${v.carpet_area} sq ft` : null],
    ['Location', [v.locality, v.city].filter(Boolean).join(', ') || null],
    ['Project', v.project_name],
    ['Possession', d.possession_status ?? v.possession_status],
  ];

  if (!opts.full) return `${head}\n${lines(core)}`;

  return `${head}\n${lines([
    ...core,
    ['Floor', v.floor],
    ['Facing', d.facing ?? v.facing],
    ['Vastu compliant', v.vastu_compliant === true ? 'Yes' : null],
    ['Corner unit', v.corner_unit === true ? 'Yes' : null],
    ['Possession date', asDate(v.possession_date)],
    ['Amenities', v.amenities],
    ['Owner', d.owner_id],
  ])}`;
}

/**
 * The number, put back together.
 *
 * A lead stores ten bare digits, so `mobile` alone is not dialable and gives a
 * model a number it will confidently recite wrong. The code is +91 — that is
 * the only country this business sells in (migration 064) — but an older record
 * that still carries one of its own is trusted over the default.
 */
function phone(v: Record<string, unknown>): string | null {
  const national = typeof v.mobile === 'string' ? v.mobile.trim() : '';
  if (!national) return null;
  const code = typeof v.country_code === 'string' && v.country_code ? v.country_code : '+91';
  return `${code} ${national}`;
}

/** A list of records as a numbered rundown, with a count line above it. */
export function list(
  rows: RecordEnvelope[],
  total: number,
  render: (row: RecordEnvelope) => string,
  emptyMessage: string,
): string {
  if (!rows.length) return emptyMessage;
  const shown = rows.map((r, i) => `${i + 1}. ${render(r).replace(/\n/g, '\n   ')}`).join('\n\n');
  const more = total > rows.length ? `\n\n(${total} match in total; showing the first ${rows.length}.)` : '';
  return `${total} match${total === 1 ? '' : 'es'}.\n\n${shown}${more}`;
}
