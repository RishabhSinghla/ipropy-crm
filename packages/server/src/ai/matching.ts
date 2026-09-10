/**
 * Property matching.
 *
 * A deterministic scorer ranks available inventory against a buyer's stated
 * requirement (budget, configuration, area, location, possession). The LLM then
 * writes the *reasoning* — why this unit suits this buyer — which is what a rep
 * actually pastes into a WhatsApp message.
 */
import { formatArea, formatIndianPrice, type PropertyMatch, toSqFt } from '@ipropy/shared';
import { recordScopeSql, type ScopeContext } from '../core/permissions/index.js';
import { scoringThresholds } from '../core/settings/scoring.js';
import { matchingConfig, pairFor, type MatchingConfig } from '../core/settings/matching.js';
import { SqlParams } from '../core/query/builder.js';
import { db } from '../db/pool.js';
import { completeJson, isAiAvailable, saveInsight, REAL_ESTATE_SYSTEM } from './client.js';

/**
 * The property field an admin has mapped "how many bedrooms" to — Admin →
 * Matching Setup, defaulting to `bedrooms`. Read through `to_jsonb(p)->>…`
 * with the key as a bound parameter rather than an identifier, so a
 * mis-typed or since-deleted field name degrades to "no value" instead of a
 * 42703 — the same contract `city`/`project_name` already get in this file —
 * and so the admin can point this at any real column on Properties without a
 * SQL-injection surface opening up.
 */
function bedroomPropertyField(config: MatchingConfig): string {
  return pairFor(config, 'configuration')?.propertyField || 'bedrooms';
}

/**
 * The property field an admin has mapped "how big" to — Admin → Matching
 * Setup, defaulting to `area`, the field that carries a unit alongside it.
 *
 * This used to be the hardcoded `carpet_area`, which was then deleted from
 * Properties outright (migration 113). Reading it through the same mapping the
 * bedroom side uses means the admin decides which of the six area fields a
 * requirement is compared against, and a field that has gone reads as "no
 * value" rather than taking the whole query down.
 */
function areaPropertyField(config: MatchingConfig): string {
  return pairFor(config, 'area')?.propertyField || 'area';
}

function parsedBedrooms(row: PropertyRow): number | null {
  if (row.matched_bedrooms_raw == null) return null;
  const n = Number(row.matched_bedrooms_raw);
  return Number.isFinite(n) ? n : null;
}

export interface Requirement {
  /** One stated price. The old min/max pair folded into this single number. */
  budget?: number | null;
  configurations?: string[];
  locations?: string[];
  /** One stated area, with the unit it was quoted in. */
  area?: number | null;
  areaUnit?: string | null;
  possessionTimeline?: string | null;
  projectName?: string | null;
  purpose?: string | null;
  facing?: string[];
  vastuRequired?: boolean;
  /** Source values used by administrator-created mapping rules. */
  rawValues?: Record<string, unknown>;
}

/*
  Nothing here names a payload column.

  Every field on Properties and on Contacts is one an administrator is allowed
  to delete, and deleting one turns a hand-written column list into
  `column "…" does not exist`. Postgres answers 42703, the API turns that into
  a 400, and buyer matching stops working on every lead and every unit in the
  CRM at once. The failure is total and silent, because callers treat "no
  matches" and "it threw" the same way — and this is the fifth time a list like
  that has done it (configuration, locality, bedrooms, area_unit, city).

  So both queries select `to_jsonb(x)` and every value is read out of the JSON
  in TypeScript. A missing column arrives as `undefined` and is handled by the
  same `?? null` that already handles an empty one. There is no list left here
  to go stale. `reconcileColumns` puts back a column the metadata still expects;
  this covers the case where the metadata does not expect it either, because
  the admin genuinely deleted the field.

  The two columns that must exist for any of this to mean anything —
  `record_id` on the payload table and `id`/`label` on ipy_record — are the
  join itself, not fields, and are named directly.
*/
interface PropertyRow {
  record_id: string;
  label: string;
  name: string | null;
  /** Whatever the admin-mapped bedroom field holds, read as text — see `bedroomPropertyField`. */
  matched_bedrooms_raw: string | null;
  /** Whatever the admin-mapped area field holds — see `areaPropertyField`. */
  matched_area: number | null;
  area_unit: string | null;
  total_price: number | null;
  base_price: number | null;
  floor: number | null;
  facing: string | null;
  vastu_compliant: boolean | null;
  status: string | null;
  possession_date: string | null;
  possession_status: string | null;
  city: string | null;
  locality: string | null;
  project_name: string | null;
  amenities: string[] | null;
  corner_unit: boolean;
  raw_values?: Record<string, unknown>;
}

/** A number out of JSON, or null — never NaN, never a throw. */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return v === null || v === undefined || v === '' ? null : String(v);
}

/**
 * One property row, assembled from `to_jsonb(p)`.
 *
 * The admin-mapped bedroom and area fields are resolved here rather than in
 * SQL, which is what lets Matching Setup point them at any field on the module
 * without a query being rewritten — and what makes a field that has since been
 * deleted read as "no value" instead of raising.
 */
function toPropertyRow(
  raw: Record<string, unknown>,
  label: string,
  bedroomField: string,
  areaField: string,
): PropertyRow {
  return {
    record_id: String(raw.record_id),
    label,
    name: str(raw.name),
    matched_bedrooms_raw: str(raw[bedroomField]),
    matched_area: num(raw[areaField]),
    area_unit: str(raw.area_unit),
    total_price: num(raw.total_price),
    base_price: num(raw.base_price),
    floor: num(raw.floor),
    facing: str(raw.facing),
    vastu_compliant: raw.vastu_compliant === true,
    status: str(raw.status),
    possession_date: str(raw.possession_date),
    possession_status: str(raw.possession_status),
    city: str(raw.city),
    locality: str(raw.locality),
    project_name: str(raw.project_name),
    amenities: Array.isArray(raw.amenities) ? (raw.amenities as string[]) : null,
    corner_unit: raw.corner_unit === true,
    raw_values: raw,
  };
}

/** Pull the requirement off a lead or contact record. */
export async function loadRequirement(recordId: string): Promise<Requirement | null> {
  // The whole row as JSON rather than a hand-written column list.
  //
  // Every name in that list was a field an administrator is free to delete, and
  // deleting one turned this query into `column "interested_project" does not
  // exist`. Postgres answers 42703, the API turns that into a 400, and property
  // matching stops working on every lead in the CRM. Nothing says which field,
  // and the admin panel gave no warning, because deleting a field it is allowed
  // to delete is not an error.
  //
  // Reading the row as JSON means a missing field arrives as `undefined` and is
  // handled by the same `?? null` that already handles an empty one. There is
  // no list here left to go stale.
  const row = await db.queryOne<{ row: Record<string, unknown> }>(
    `SELECT to_jsonb(l) AS row FROM ipy_e_leads l WHERE l.record_id = $1`,
    [recordId],
  );
  const lead = row?.row;
  if (lead) {
    // A per-unit budget ("₹8,500/sq.yd.") is not an absolute price, and matching
    // compares absolute prices. Where the buyer also stated an area, the unit
    // qualifier turns into a number the engine can compare: 8500/sq.yd. over
    // 1200 sq.ft. is a ₹1.1 Cr budget. Without an area the number stands as
    // typed — a per-unit figure with nothing to multiply by is still closer
    // than throwing the requirement away.
    let budget = lead.budget as number | null;
    const unit = (lead.budget_unit as string | null) ?? 'total';
    const area = lead.area as number | null;
    const areaUnit = (lead.area_unit as string | null) ?? 'sqft';
    if (budget != null && unit !== 'total' && area != null) {
      const sqft = toSqFt(area, areaUnit);
      const per = unit === 'sqft' ? budget : toSqFt(budget, 'sqyd');
      budget = Math.round(per * sqft);
    }
    return {
      budget,
      configurations: (lead.configuration as string[]) ?? [],
      locations: (lead.preferred_locations as string[]) ?? [],
      area: lead.area as number | null,
      areaUnit: (lead.area_unit as string | null) ?? 'sqft',
      possessionTimeline: lead.possession_timeline as string | null,
      projectName: lead.interested_project as string | null,
      purpose: lead.purpose as string | null,
      rawValues: lead,
    };
  }

  return null;
}

/**
 * Inventory worth scoring against this requirement.
 *
 * `projectName` is a hard filter here, which is right until it is not: a buyer
 * who names a project they cannot afford — "I want Skyline Aurum", budget ₹65 L,
 * nothing there under ₹2.3 Cr — matches nothing at all, and the rep is shown an
 * empty list rather than the eight units the buyer could actually buy. Seen
 * against real seeded data at scale.
 *
 * So the project narrows the search when it can, and steps aside when it cannot.
 * Silence is the one answer that is never useful to somebody about to make a
 * call.
 */
async function candidateInventory(req: Requirement, config: MatchingConfig, limit = 60, scope?: ScopeContext): Promise<PropertyRow[]> {
  const withProject = await queryInventory(req, config, limit, scope);
  if (withProject.length || !req.projectName) return withProject;
  return queryInventory({ ...req, projectName: null }, config, limit, scope);
}

async function queryInventory(req: Requirement, config: MatchingConfig, limit: number, scope?: ScopeContext): Promise<PropertyRow[]> {
  // Grace is admin-set (Admin → Matching Setup, default 10%) and applied
  // symmetrically — this used to be a hardcoded 10% over / 20% under.
  const grace = config.priceGracePercent / 100;
  const maxPrice = req.budget ? req.budget * (1 + grace) : null;
  const minPrice = req.budget ? req.budget * (1 - grace) : null;
  const bedroomField = bedroomPropertyField(config);
  const wantedBedrooms = req.configurations?.map(bhkNumber).filter((n): n is number => n !== null) ?? [];

  // One accumulator for the whole statement: the scope fragment appends its
  // own params, so numbering by hand past it would collide.
  const params = new SqlParams();
  const maxP = params.add(maxPrice);
  const minP = params.add(minPrice);
  const projectP = params.add(req.projectName ?? null);
  const limitP = params.add(limit);
  const bedroomFieldP = params.add(bedroomField);
  const wantedBedroomsP = params.add(wantedBedrooms.length ? wantedBedrooms : [-1]);
  const locationP = params.add(req.locations?.length ? req.locations : ['']);
  // The permission fragment for the candidate rows, or nothing when this
  // caller can see the whole table — a workflow or the scheduler has no user.
  const scopeSql = scope
    ? await (async () => { const f = await recordScopeSql(scope, 'properties', params, false); return f ? `AND ${f}` : ''; })()
    : '';

  const areaField = areaPropertyField(config);

  /*
    `ipy_try_numeric` rather than `::numeric`.

    Price and bedroom counts are read out of JSON as text, and text that is not
    a number raises 22P02 — which fails the statement, not the row. That can
    happen for reasons an admin is entitled to cause: a field retyped from Text
    to Currency leaves the values that were typed before it, and a mapping
    pointed at a text field compares fine in TypeScript but not in a cast. The
    helper answers NULL, which is what "no comparable value" means here.
  */
  const res = await db.query<{ record_id: string; label: string; row: Record<string, unknown> }>(
    `SELECT p.record_id, r.label, to_jsonb(p) AS row
     FROM ipy_e_properties p
     JOIN ipy_record r ON r.id = p.record_id
     WHERE r.is_deleted = false
       AND to_jsonb(p)->>'status' = 'Available'
       AND (${maxP}::numeric IS NULL OR COALESCE(
             ipy_try_numeric(to_jsonb(p)->>'total_price'),
             ipy_try_numeric(to_jsonb(p)->>'base_price')) <= ${maxP})
       AND (${minP}::numeric IS NULL OR COALESCE(
             ipy_try_numeric(to_jsonb(p)->>'total_price'),
             ipy_try_numeric(to_jsonb(p)->>'base_price')) >= ${minP})
       AND (${projectP}::text IS NULL OR to_jsonb(p)->>'project_name' ILIKE ${projectP})
       ${scopeSql}
     -- Relevance before price, for the same reason the reverse match orders by
     -- it: this takes a bounded slice and scores it in memory, so the slice has
     -- to be the units most likely to suit *this* buyer. Ordering by price
     -- alone took the sixty cheapest in their band, which at a few hundred
     -- units in budget means a perfect 3 BHK in their preferred area loses to
     -- sixty cheap 1 BHKs somewhere else. Price still breaks the tie, because
     -- among equally suitable units the cheaper one is the better pitch.
     ORDER BY (ipy_try_numeric(to_jsonb(p)->>${bedroomFieldP}) = ANY(${wantedBedroomsP}::numeric[])) DESC NULLS LAST,
              (to_jsonb(p)->>'locality' = ANY(${locationP}::text[])) DESC NULLS LAST,
              COALESCE(
                ipy_try_numeric(to_jsonb(p)->>'total_price'),
                ipy_try_numeric(to_jsonb(p)->>'base_price')) ASC NULLS LAST
     LIMIT ${limitP}`,
    params.all(),
  );
  return res.rows.map((r) => toPropertyRow(r.row, r.label, bedroomField, areaField));
}

interface ScoredProperty {
  row: PropertyRow;
  score: number;
  reasons: string[];
  mismatches: string[];
}

function scoreProperty(row: PropertyRow, req: Requirement, config: MatchingConfig): ScoredProperty {
  let score = 50;
  const reasons: string[] = [];
  const mismatches: string[] = [];
  const price = row.total_price ?? row.base_price ?? 0;
  // Admin-set (Admin → Matching Setup, default 10%). Replaces what used to be
  // three hardcoded numbers (0.9/1.05/0.7) scaled off a single fixed 10%.
  const grace = config.priceGracePercent / 100;

  // Budget fit — the dominant factor.
  if (req.budget && price) {
    const ratio = price / req.budget;
    if (ratio <= 1 - grace / 2) { score += 22; reasons.push(`${formatIndianPrice(price)} sits comfortably under the ${formatIndianPrice(req.budget)} budget`); }
    else if (ratio <= 1.0) { score += 18; reasons.push(`${formatIndianPrice(price)} fits the stated budget`); }
    else if (ratio <= 1 + grace) { score += 6; mismatches.push(`${Math.round((ratio - 1) * 100)}% above budget — negotiable`); }
    else { score -= 15; mismatches.push(`${formatIndianPrice(price)} exceeds the budget by ${Math.round((ratio - 1) * 100)}%`); }
  }
  if (req.budget && price && price < req.budget * (1 - grace * 1.5)) {
    score -= 8;
    mismatches.push('Well below the buyer\'s stated budget — may read as a downgrade');
  }

  // Bedrooms — the field admin-mapped to the buyer's "configuration" wish
  // list (Admin → Matching Setup, default `bedrooms`).
  const actualBedrooms = parsedBedrooms(row);
  const wantedBedrooms = req.configurations?.map(bhkNumber).filter((n): n is number => n !== null) ?? [];
  if (wantedBedrooms.length && actualBedrooms !== null) {
    if (wantedBedrooms.includes(actualBedrooms)) {
      score += 20;
      reasons.push(`${actualBedrooms} BHK matches the requirement`);
    } else if (wantedBedrooms.some((w) => Math.abs(w - actualBedrooms) <= 1)) {
      // Adjacent bedroom counts are a soft miss, not a hard one.
      score += 5;
      mismatches.push(`${actualBedrooms} BHK instead of ${req.configurations!.join('/')}`);
    } else {
      score -= 12;
      mismatches.push(`${actualBedrooms} BHK does not match the requested ${req.configurations!.join('/')}`);
    }
  }

  // Location.
  if (req.locations?.length) {
    const locality = (row.locality ?? '').toLowerCase();
    const city = (row.city ?? '').toLowerCase();
    const hit = req.locations.some((l) => {
      const wanted = l.toLowerCase();
      return locality.includes(wanted) || wanted.includes(locality) || city.includes(wanted);
    });
    if (hit) { score += 15; reasons.push(`Located in ${row.locality ?? row.city}, a preferred area`); }
    else { score -= 10; mismatches.push(`${row.locality ?? row.city ?? 'Location'} is outside the preferred areas`); }
  }

  // Area. The buyer states one figure, so it is read as "about this much";
  // the administrator sets this tolerance independently from budget pricing.
  if (row.matched_area && req.area) {
    /*
      Both sides converted before dividing.

      Faridabad quotes plots in gaj and flats in square feet, so a buyer asking
      for 200 and a listing offering 1,800 are the same size. This divided one by
      the other as though the numbers were comparable, which made 200 gaj look
      nine times too small — and a ratio of 9 lands in the silent `else` below,
      so the unit lost 3 points and the rep was shown no sentence to notice was
      wrong. The rename guard already says this field is needed "because a number
      without its unit matches nothing correctly"; it simply was not read.

      Each side is printed in the unit it was quoted in, so a gaj buyer reads
      "1,850 sq.ft is about the 200 sq.yd asked for" rather than a converted
      figure they never typed.
    */
    const wanted = toSqFt(req.area, req.areaUnit);
    const offered = toSqFt(row.matched_area, row.area_unit);
    const ratio = offered / wanted;
    const areaGrace = config.areaGracePercent / 100;
    if (ratio >= 1 - areaGrace && ratio <= 1 + areaGrace) {
      score += 8;
      reasons.push(
        `${formatArea(row.matched_area, row.area_unit ?? 'sqft')} is about the `
        + `${formatArea(req.area, req.areaUnit)} asked for`,
      );
    } else if (ratio < 1 - areaGrace) {
      score -= 8;
      mismatches.push(
        `${formatArea(row.matched_area, row.area_unit ?? 'sqft')} is smaller than the `
        + `${formatArea(req.area, req.areaUnit)} asked for`,
      );
    } else {
      score -= 3;
    }
  }

  // Possession alignment — an urgent buyer cannot wait three years.
  const urgent = ['Immediate', 'Within 1 Month', '1-3 Months'].includes(req.possessionTimeline ?? '');
  if (urgent) {
    if (row.possession_status === 'Ready To Move') {
      score += 14;
      reasons.push('Ready to move — matches an urgent timeline');
    } else if (row.possession_date) {
      const monthsAway = (new Date(row.possession_date).getTime() - Date.now()) / (30 * 86_400_000);
      if (monthsAway > 12) {
        score -= 12;
        mismatches.push(`Possession is ~${Math.round(monthsAway)} months away, against an urgent timeline`);
      } else if (monthsAway <= 6) {
        score += 8;
        reasons.push(`Possession in ~${Math.max(0, Math.round(monthsAway))} months`);
      }
    }
  }

  // Desirability nudges.
  if (row.corner_unit) { score += 4; reasons.push('Corner unit'); }
  if (row.vastu_compliant) { score += 3; reasons.push('Vastu compliant'); }
  if (row.facing && ['North', 'East', 'North-East'].includes(row.facing)) {
    score += 3;
    reasons.push(`${row.facing} facing`);
  }
  if (row.floor && row.floor >= 8) { score += 2; }

  // Investors weigh rental yield and entry price over lifestyle fit.
  if (req.purpose === 'Investment') {
    if (row.possession_status === 'New Launch') {
      score += 6;
      reasons.push('Early-stage pricing suits an investment purpose');
    }
  }

  // Extra administrator-created mappings are evaluated without a code change.
  // The familiar budget/BHK/location/area pairs above keep their specialised
  // tolerance logic; all other configured fields get a transparent, modest
  // score contribution from exact/contained values.
  for (const pair of config.fieldMap) {
    if (['budget', 'configuration', 'preferred_locations', 'area'].includes(pair.contactField)) continue;
    const wanted = req.rawValues?.[pair.contactField];
    const offered = row.raw_values?.[pair.propertyField];
    if (wanted === null || wanted === undefined || wanted === '' || offered === null || offered === undefined || offered === '') continue;
    const want = (Array.isArray(wanted) ? wanted : [wanted]).map((v) => String(v).toLowerCase());
    const have = (Array.isArray(offered) ? offered : [offered]).map((v) => String(v).toLowerCase());
    const matched = want.some((w) => have.some((h) => h === w || h.includes(w) || w.includes(h)));
    const label = pair.contactLabel ?? pair.contactField;
    if (matched) { score += 7; reasons.push(`${label} matches`); }
    else { score -= 4; mismatches.push(`${label} does not match`); }
  }

  return {
    row,
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons: reasons.slice(0, 5),
    mismatches: mismatches.slice(0, 3),
  };
}

export function bhkNumber(config: string): number | null {
  const m = config.match(/^([\d.]+)\s*(BHK|RK)/i);
  return m ? Number(m[1]) : null;
}

export interface MatchOptions {
  limit?: number;
  /** ask the LLM to write the pitch reasoning */
  withNarrative?: boolean;
  persist?: boolean;
  recordId?: string;
  /**
   * Caller's permission scope. When present, candidates the caller cannot
   * view are excluded — in SQL, not afterwards, so a private record never
   * reaches the scorer that would have ranked it. Matching runs against the
   * whole table by design when driven by a workflow or the scheduler, which
   * have no user; the API routes always pass one.
   */
  scope?: ScopeContext;
}

export async function matchProperties(
  req: Requirement,
  opts: MatchOptions = {},
): Promise<PropertyMatch[]> {
  const config = await matchingConfig();
  const candidates = await candidateInventory(req, config, 60, opts.scope);
  if (!candidates.length) return [];

  const scored = candidates
    .map((row) => scoreProperty(row, req, config))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 6);

  let matches: PropertyMatch[] = scored.map((s) => ({
    propertyId: s.row.record_id,
    propertyLabel: s.row.label || s.row.name || 'Unnamed unit',
    score: s.score,
    reasons: s.reasons,
    mismatches: s.mismatches,
    projectName: s.row.project_name ?? undefined,
    price: s.row.total_price ?? s.row.base_price ?? undefined,
    bedrooms: parsedBedrooms(s.row),
  }));

  if (opts.withNarrative && isAiAvailable() && matches.length) {
    const narrated = await addNarrative(req, scored, opts.recordId);
    if (narrated) matches = narrated;
  }

  if (opts.persist && opts.recordId) {
    await saveInsight({
      recordId: opts.recordId,
      module: null,
      kind: 'property_match',
      title: `${matches.length} matching properties found`,
      body: matches
        .map((m, i) => `${i + 1}. **${m.propertyLabel}** (${m.score}/100) — ${m.reasons[0] ?? ''}`)
        .join('\n'),
      data: { matches },
      score: matches[0]?.score ?? null,
      replace: true,
    });
  }

  return matches;
}

async function addNarrative(
  req: Requirement,
  scored: ScoredProperty[],
  recordId?: string,
): Promise<PropertyMatch[] | null> {
  const prompt = `A buyer has this requirement:
- Budget: ${req.budget ? formatIndianPrice(req.budget) : '—'}
- Bedrooms wanted: ${req.configurations?.join(', ') || '—'}
- Preferred locations: ${req.locations?.join(', ') || '—'}
- Area: ${req.area ?? '—'} ${req.areaUnit ?? 'sqft'}
- Timeline: ${req.possessionTimeline ?? '—'}
- Purpose: ${req.purpose ?? 'Buy'}

Here are the shortlisted units with their computed fit scores:

${scored.map((s, i) => `### ${i + 1}. ${s.row.label} (score ${s.score})
- Project: ${s.row.project_name ?? '—'}
- Bedrooms: ${parsedBedrooms(s.row) ?? '—'}, ${formatArea(s.row.matched_area, s.row.area_unit ?? 'sqft')}
- Price: ${formatIndianPrice(s.row.total_price ?? s.row.base_price ?? 0)}
- Floor ${s.row.floor ?? '—'}, ${s.row.facing ?? '—'} facing${s.row.corner_unit ? ', corner unit' : ''}
- Location: ${s.row.locality ?? '—'}, ${s.row.city ?? '—'}
- Possession: ${s.row.possession_status ?? '—'}${s.row.possession_date ? ` (${s.row.possession_date})` : ''}
- Computed strengths: ${s.reasons.join('; ') || 'none'}
- Computed gaps: ${s.mismatches.join('; ') || 'none'}`).join('\n\n')}

For each unit, write the pitch a sales rep should make to *this specific buyer*. Ground every claim in the data above — do not invent amenities, prices or dates.

Return JSON:
{
  "matches": [
    { "index": <1-based index above>, "reasons": [<2-3 persuasive, specific strings>], "mismatches": [<0-2 honest caveats>] }
  ]
}`;

  const parsed = await completeJson<{ matches: { index: number; reasons: string[]; mismatches: string[] }[] }>({
    feature: 'property_matching',
    system: REAL_ESTATE_SYSTEM,
    prompt,
    maxTokens: 2000,
    recordId: recordId ?? null,
  });
  if (!parsed?.matches) return null;

  const byIndex = new Map(parsed.matches.map((m) => [m.index, m]));
  return scored.map((s, i) => {
    const enriched = byIndex.get(i + 1);
    return {
      propertyId: s.row.record_id,
      propertyLabel: s.row.label || s.row.name || 'Unnamed unit',
      score: s.score,
      reasons: enriched?.reasons?.length ? enriched.reasons : s.reasons,
      mismatches: enriched?.mismatches?.length ? enriched.mismatches : s.mismatches,
      projectName: s.row.project_name ?? undefined,
      price: s.row.total_price ?? s.row.base_price ?? undefined,
      bedrooms: parsedBedrooms(s.row),
    };
  });
}

/** Convenience: match directly from a lead or contact id. */
export async function matchForRecord(recordId: string, opts: MatchOptions = {}): Promise<PropertyMatch[]> {
  const req = await loadRequirement(recordId);
  if (!req) return [];
  return matchProperties(req, { ...opts, recordId, persist: opts.persist ?? true });
}

/**
 * Whether the arrival of *this* unit answers the reason a lead was lost.
 *
 * A lead marked Lost is not one fact, it is twelve different facts wearing the
 * same label, and they do not age alike. "Bought Elsewhere" is permanent —
 * they own a house. "Price Too High" is a statement about one number on one
 * day, and the day a unit lands inside their budget it has expired.
 *
 * So a revival needs the new unit to specifically undo the objection, not
 * merely to score well. Without that this degrades into ringing everybody who
 * ever said no, which is worse than not calling them: it is cold-calling with
 * the CRM's blessing, and it teaches a rep to ignore the alert.
 *
 * Returns the sentence to put in front of the rep, or null to leave the lead
 * where it is.
 */
function revivalReason(
  lostReason: string | null,
  property: PropertyRow,
  req: Requirement,
): string | null {
  if (!lostReason) return null;
  const price = property.total_price ?? property.base_price ?? 0;
  const inBudget = Boolean(req.budget && price && price <= req.budget);

  switch (lostReason) {
    // The objection was a number, and the number has changed.
    case 'Price Too High':
    case 'Budget Mismatch':
      return inBudget
        ? `Lost on price — this one is ${formatIndianPrice(price)}, inside their ${formatIndianPrice(req.budget!)} budget`
        : null;

    // They wanted something we did not have. Now we do.
    case 'Unit Not Available':
      return `Lost because nothing suitable was available — this unit is`;

    case 'Location Not Suitable': {
      const locality = (property.locality ?? '').toLowerCase();
      const hit = (req.locations ?? []).some((l) => {
        const wanted = l.toLowerCase();
        return locality.includes(wanted) || wanted.includes(locality);
      });
      return hit ? `Lost on location — this one is in ${property.locality}, which they asked for` : null;
    }

    case 'Possession Timeline': {
      const urgent = ['Immediate', 'Within 1 Month', '1-3 Months'].includes(req.possessionTimeline ?? '');
      return urgent && property.possession_status === 'Ready To Move'
        ? 'Lost on possession timing — this one is ready to move'
        : null;
    }

    case 'Vastu Concerns':
      return property.vastu_compliant ? 'Lost over Vastu — this unit is compliant' : null;

    // Deliberately never revived, and each for its own reason:
    //   Bought Elsewhere  — they own a home now.
    //   Loan Rejected     — no unit at any price fixes their financing.
    //   Postponed Purchase— about their year, not our inventory.
    //   No Response       — we never learned what they wanted, so a match here
    //                       is a guess dressed up as a signal.
    //   Competitor Offered Better / Legal-RERA — about a rival's deal or a
    //                       project's paperwork; a different unit says nothing.
    default:
      return null;
  }
}

/**
 * Configurations a buyer might accept for this unit.
 *
 * The scorer treats an adjacent BHK count as a soft miss rather than a
 * disqualification — somebody wanting a 3 BHK will look at a 2.5 — so the SQL
 * ordering has to know about that too, or it would rank a genuine near-match
 * below an irrelevant lead with a high AI score.
 */
function acceptableConfigurations(bedrooms: number | null): string[] {
  if (bedrooms == null) return [];
  const out = new Set<string>();
  for (const step of [-1, -0.5, 0, 0.5, 1]) {
    const near = bedrooms + step;
    if (near <= 0) continue;
    out.add(`${Number.isInteger(near) ? near : near.toFixed(1)} BHK`);
  }
  if (bedrooms === 1) out.add('1 RK');
  return [...out];
}

/** How much better a revival has to look than an ordinary match to be worth the call. */
const REVIVAL_SCORE_FLOOR = 70;

export interface BuyerMatch {
  recordId: string;
  label: string;
  module: string;
  score: number;
  ownerId: string | null;
  reasons: string[];
  /** Set when this is somebody who previously said no, explaining what changed. */
  revival?: string;
  /** Table columns for the Matching contacts tab — what a rep scans before ringing. */
  budget?: number | null;
  configuration?: string[] | null;
  preferredLocations?: string[] | null;
  possessionTimeline?: string | null;
  purpose?: string | null;
  status?: string | null;
  wasLost?: boolean;
}

/**
 * Reverse match: given a property, which open leads should be pitched it?
 * Used when a unit is released or repriced.
 */
export async function matchBuyersForProperty(
  propertyId: string,
  limit = 10,
  scope?: ScopeContext,
  opts: { withNarrative?: boolean } = {},
): Promise<BuyerMatch[]> {
  const [{ matchFloor }, config] = await Promise.all([scoringThresholds(), matchingConfig()]);
  const bedroomField = bedroomPropertyField(config);
  const areaField = areaPropertyField(config);
  const propertyRaw = await db.queryOne<{ record_id: string; label: string; row: Record<string, unknown> }>(
    `SELECT p.record_id, r.label, to_jsonb(p) AS row
     FROM ipy_e_properties p JOIN ipy_record r ON r.id = p.record_id
     WHERE p.record_id = $1`,
    [propertyId],
  );
  if (!propertyRaw) return [];
  const property = toPropertyRow(propertyRaw.row, propertyRaw.label, bedroomField, areaField);

  const price = property.total_price ?? property.base_price ?? 0;

  // One accumulator: the scope fragment appends its own params after these.
  const params = new SqlParams();
  const priceP = params.add(price);
  const gracePP = params.add(config.priceGracePercent / 100);
  const configP = params.add(acceptableConfigurations(parsedBedrooms(property)));
  const localityP = params.add(property.locality ?? '');
  const scopeSql = scope
    ? await (async () => { const f = await recordScopeSql(scope, 'leads', params, false); return f ? `AND ${f}` : ''; })()
    : '';

  const leads = await db.query<{ record_id: string; label: string; owner_id: string | null; row: Record<string, unknown> }>(
    // Lost leads are in scope now; Junk never is. A wrong number, a broker
    // fishing or a test entry does not become a buyer because a unit appeared,
    // and `revivalReason` is what decides which of the Lost are worth raising.
    //
    // The budget bound is relaxed for them: somebody lost on price stated a
    // number *before* saying no, and the whole point is that this unit may now
    // sit under it — filtering on the same ±band as a live lead would drop
    // exactly the ones worth reviving.
    // Same rule as the forward direction: no payload column is named. Every
    // one of budget, area, configuration, possession_timeline, purpose and
    // lost_reason is a field an admin may delete, and one deletion used to
    // take the whole reverse match down with a 42703.
    `SELECT l.record_id, r.label, r.owner_id, to_jsonb(l) AS row
     FROM ipy_e_leads l JOIN ipy_record r ON r.id = l.record_id
     WHERE r.is_deleted = false
       AND COALESCE((to_jsonb(l)->>'is_converted')::boolean, false) = false
       AND COALESCE(to_jsonb(l)->>'status', '') <> 'Junk'
       AND (
         COALESCE(to_jsonb(l)->>'status', '') <> 'Lost'
           AND (ipy_try_numeric(to_jsonb(l)->>'budget') IS NULL
             OR to_jsonb(l)->>'budget_unit' NOT IN ('total') AND to_jsonb(l)->>'area' IS NOT NULL
             OR (ipy_try_numeric(to_jsonb(l)->>'budget') >= ${priceP} * (1 - ${gracePP}::numeric)
                 AND ipy_try_numeric(to_jsonb(l)->>'budget') <= ${priceP} * (1 + ${gracePP}::numeric)))
         OR to_jsonb(l)->>'status' = 'Lost' AND to_jsonb(l)->>'lost_reason' IS NOT NULL
       )
       ${scopeSql}
     -- Ordered by how likely this lead is to match *this unit*, not by how
     -- good a lead they are in general.
     --
     -- This was ORDER BY ai_score DESC LIMIT 400, which is correct-looking
     -- and silently wrong the moment the table outgrows the limit. At a
     -- hundred leads, 400 means everybody and the JS scorer sees the whole
     -- table. At sixty thousand it means the four hundred highest-scoring
     -- leads in the business — a slice with no relationship to whether any of
     -- them wants a 4 BHK in Baner. Measured: ten buyers per unit at 99 leads,
     -- zero at 60,000, from the same code. The alert would have quietly
     -- stopped working as the desk grew, which is the worst way for a feature
     -- to fail.
     --
     -- Nothing is excluded that was not excluded before — the scorer still
     -- decides, and still forgives a location miss or an adjacent BHK count.
     -- This only makes the four hundred rows fetched the right four hundred.
     ORDER BY (COALESCE(to_jsonb(l)->'configuration', '[]'::jsonb) ?| ${configP}::text[]) DESC,
              (COALESCE(to_jsonb(l)->'preferred_locations', '[]'::jsonb) ? ${localityP}) DESC,
              r.updated_at DESC
     LIMIT 400`,
    params.all(),
  );

  const buyers = leads.rows
    .map(({ row: raw, ...lead }) => {
      // Every value is read out of `to_jsonb(l)`, so a deleted field is
      // `undefined` here and falls through the same defaults an empty one does.
      const status = str(raw.status);
      const lostReason = str(raw.lost_reason);
      const configuration = Array.isArray(raw.configuration) ? (raw.configuration as string[]) : [];
      const preferredLocations = Array.isArray(raw.preferred_locations) ? (raw.preferred_locations as string[]) : [];
      const leadArea = num(raw.area);

      // Same normalisation as loadRequirement: a per-unit budget with a stated
      // area becomes the absolute figure the scorer compares.
      let budget = num(raw.budget);
      const unit = str(raw.budget_unit) ?? 'total';
      if (budget != null && unit !== 'total' && leadArea != null) {
        const sqft = toSqFt(leadArea, str(raw.area_unit) ?? 'sqft');
        const per = unit === 'sqft' ? budget : toSqFt(budget, 'sqyd');
        budget = Math.round(per * sqft);
      }
      const req: Requirement = {
        budget,
        configurations: configuration,
        locations: preferredLocations,
        possessionTimeline: str(raw.possession_timeline),
        purpose: str(raw.purpose),
        rawValues: raw,
      };
      const scored = scoreProperty(property, req, config);
      const revival = status === 'Lost'
        ? revivalReason(lostReason, property, req)
        : null;

      return {
        wasLost: status === 'Lost',
        match: {
          recordId: lead.record_id,
          label: lead.label,
          module: 'leads',
          score: scored.score,
          ownerId: lead.owner_id,
          // The revival sentence leads, because "they told you no over price
          // and this one is in budget" is the reason to ring them; the scoring
          // reasons are the supporting detail.
          reasons: revival ? [revival, ...scored.reasons] : scored.reasons,
          ...(revival ? { revival } : {}),
          // The columns the Matching contacts table shows — the requirement as
          // the buyer stated it, so the rep can weigh the fit themselves rather
          // than trusting a single number.
          budget: num(raw.budget),
          configuration,
          preferredLocations,
          possessionTimeline: str(raw.possession_timeline),
          purpose: str(raw.purpose),
          status,
        } satisfies BuyerMatch,
      };
    })
    // The SQL over-fetches Lost leads because it cannot tell whether this unit
    // answers their objection — only `revivalReason` can. A Lost lead with no
    // revival is dropped here; without this, one lost to "Bought Elsewhere"
    // would reappear on score alone.
    .filter(({ wasLost, match }) => !wasLost || match.revival)
    // A revival is a colder call than a live enquiry — the person has already
    // said no once — so it clears a higher bar to earn the interruption.
    .filter(({ match }) => match.score >= (match.revival ? REVIVAL_SCORE_FLOOR : matchFloor))
    .map(({ match }) => match)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  /*
    The LLM writes the pitch reasoning for the buyer rows too — the same
    contract as the properties direction: the scorer decides *who*, the model
    explains *why*, grounded in the same data and falling back to the
    deterministic reasons whenever no provider answers.
  */
  if (opts.withNarrative && isAiAvailable() && buyers.length) {
    const narrated = await addBuyerNarrative(property, buyers);
    if (narrated) return narrated;
  }

  return buyers;
}

/**
 * The reasoning layer for the reverse direction: one model call explains every
 * matched buyer in the language a rep would use on the call.
 */
async function addBuyerNarrative(property: PropertyRow, buyers: BuyerMatch[]): Promise<BuyerMatch[] | null> {
  const prompt = `A property is available:
- Unit: ${property.label}
- Project: ${property.project_name ?? '—'}
- Bedrooms: ${parsedBedrooms(property) ?? '—'}, ${formatArea(property.matched_area, property.area_unit ?? 'sqft')}
- Price: ${formatIndianPrice(property.total_price ?? property.base_price ?? 0)}
- Floor ${property.floor ?? '—'}, ${property.facing ?? '—'} facing${property.corner_unit ? ', corner unit' : ''}
- Location: ${property.locality ?? '—'}
- Possession: ${property.possession_status ?? '—'}${property.possession_date ? ` (${property.possession_date})` : ''}
- Amenities: ${(property.amenities ?? []).join(', ') || '—'}

Here are the matched contacts with their computed fit scores:

${buyers.map((b, i) => `### ${i + 1}. ${b.label} (score ${b.score})
- Budget: ${b.budget ? formatIndianPrice(b.budget) : '—'}
- Wanted configuration: ${b.configuration?.join(', ') || '—'}
- Preferred areas: ${b.preferredLocations?.join(', ') || '—'}
- Possession timeline: ${b.possessionTimeline ?? '—'}
- Purpose: ${b.purpose ?? '—'}
- Status: ${b.status ?? '—'}${b.revival ? `\n- Revival angle: ${b.revival}` : ''}
- Computed strengths: ${b.reasons.join('; ') || 'none'}`).join('\n\n')}

For each contact, write the reason a sales rep should pitch *this unit* to *this person*. Ground every claim in the data above — do not invent amenities, prices or dates.

Return JSON:
{
  "matches": [
    { "index": <1-based index above>, "reasons": [<2-3 persuasive, specific strings>] }
  ]
}`;

  const parsed = await completeJson<{ matches: { index: number; reasons: string[] }[] }>({
    feature: 'property_matching',
    system: REAL_ESTATE_SYSTEM,
    prompt,
    maxTokens: 2000,
    recordId: property.record_id,
  });
  if (!parsed?.matches) return null;

  const byIndex = new Map(parsed.matches.map((m) => [m.index, m]));
  return buyers.map((b, i) => {
    const enriched = byIndex.get(i + 1);
    return enriched?.reasons?.length
      ? { ...b, reasons: enriched.reasons }
      : b;
  });
}
