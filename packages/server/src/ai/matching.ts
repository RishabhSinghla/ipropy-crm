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
import { SqlParams } from '../core/query/builder.js';
import { db } from '../db/pool.js';
import { completeJson, isAiAvailable, saveInsight, REAL_ESTATE_SYSTEM } from './client.js';

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
}

/*
  `city` and `project_name` are read as JSON rather than named as columns.

  Both were deliberately deleted from this CRM — one area, one kind of stock, so
  a city filter and a project grouping were both noise. Naming a dropped column
  in a SELECT is a Postgres 42703, which throws, so every one of these queries
  raised and buyer matching stopped working entirely: no buyers for a new unit,
  no units for a buyer. The failure was total and silent, because the callers
  treat "no matches" and "it threw" the same way.

  `to_jsonb(p)->>'…'` turns a missing column into a null, which is what a missing
  value is. Only the two optional, deletable ones go through it; the rest are
  structural and their absence should be loud.
*/
interface PropertyRow {
  record_id: string;
  label: string;
  name: string;
  configuration: string | null;
  carpet_area: number | null;
  area_unit: string | null;
  total_price: number | null;
  base_price: number | null;
  floor: number | null;
  facing: string | null;
  vastu_compliant: boolean | null;
  status: string;
  possession_date: string | null;
  possession_status: string | null;
  city: string | null;
  locality: string | null;
  project_name: string | null;
  amenities: string[] | null;
  corner_unit: boolean;
  bedrooms: number | null;
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
async function candidateInventory(req: Requirement, limit = 60, scope?: ScopeContext): Promise<PropertyRow[]> {
  const withProject = await queryInventory(req, limit, scope);
  if (withProject.length || !req.projectName) return withProject;
  return queryInventory({ ...req, projectName: null }, limit, scope);
}

async function queryInventory(req: Requirement, limit: number, scope?: ScopeContext): Promise<PropertyRow[]> {
  // Allow 10% headroom over the stated number — buyers routinely stretch —
  // and 20% underneath, where a smaller config of the same building still
  // interests them.
  const maxPrice = req.budget ? req.budget * 1.1 : null;
  const minPrice = req.budget ? req.budget * 0.8 : null;

  // One accumulator for the whole statement: the scope fragment appends its
  // own params, so numbering by hand past it would collide.
  const params = new SqlParams();
  const maxP = params.add(maxPrice);
  const minP = params.add(minPrice);
  const projectP = params.add(req.projectName ?? null);
  const limitP = params.add(limit);
  const configP = params.add(req.configurations?.length ? req.configurations : ['']);
  const locationP = params.add(req.locations?.length ? req.locations : ['']);
  // The permission fragment for the candidate rows, or nothing when this
  // caller can see the whole table — a workflow or the scheduler has no user.
  const scopeSql = scope
    ? await (async () => { const f = await recordScopeSql(scope, 'properties', params, false); return f ? `AND ${f}` : ''; })()
    : '';

  const res = await db.query<PropertyRow>(
    `SELECT p.record_id, r.label, p.name, p.configuration, p.carpet_area, p.area_unit, p.total_price,
            p.base_price, p.floor, p.facing, p.vastu_compliant, p.status,
            p.possession_date, p.possession_status, p.locality,
            p.amenities, p.corner_unit, p.bedrooms,
            to_jsonb(p)->>'city'         AS city,
            to_jsonb(p)->>'project_name' AS project_name
     FROM ipy_e_properties p
     JOIN ipy_record r ON r.id = p.record_id
     WHERE r.is_deleted = false
       AND p.status = 'Available'
       AND (${maxP}::numeric IS NULL OR COALESCE(p.total_price, p.base_price) <= ${maxP})
       AND (${minP}::numeric IS NULL OR COALESCE(p.total_price, p.base_price) >= ${minP})
       AND (${projectP}::text IS NULL OR to_jsonb(p)->>'project_name' ILIKE ${projectP})
       ${scopeSql}
     -- Relevance before price, for the same reason the reverse match orders by
     -- it: this takes a bounded slice and scores it in memory, so the slice has
     -- to be the units most likely to suit *this* buyer. Ordering by price
     -- alone took the sixty cheapest in their band, which at a few hundred
     -- units in budget means a perfect 3 BHK in their preferred area loses to
     -- sixty cheap 1 BHKs somewhere else. Price still breaks the tie, because
     -- among equally suitable units the cheaper one is the better pitch.
     ORDER BY (p.configuration = ANY(${configP}::text[])) DESC,
              (p.locality = ANY(${locationP}::text[])) DESC,
              COALESCE(p.total_price, p.base_price) ASC
     LIMIT ${limitP}`,
    params.all(),
  );
  return res.rows;
}

interface ScoredProperty {
  row: PropertyRow;
  score: number;
  reasons: string[];
  mismatches: string[];
}

function scoreProperty(row: PropertyRow, req: Requirement): ScoredProperty {
  let score = 50;
  const reasons: string[] = [];
  const mismatches: string[] = [];
  const price = row.total_price ?? row.base_price ?? 0;

  // Budget fit — the dominant factor.
  if (req.budget && price) {
    const ratio = price / req.budget;
    if (ratio <= 0.9) { score += 22; reasons.push(`${formatIndianPrice(price)} sits comfortably under the ${formatIndianPrice(req.budget)} budget`); }
    else if (ratio <= 1.0) { score += 18; reasons.push(`${formatIndianPrice(price)} fits the stated budget`); }
    else if (ratio <= 1.05) { score += 6; mismatches.push(`${Math.round((ratio - 1) * 100)}% above budget — negotiable`); }
    else { score -= 15; mismatches.push(`${formatIndianPrice(price)} exceeds the budget by ${Math.round((ratio - 1) * 100)}%`); }
  }
  if (req.budget && price && price < req.budget * 0.7) {
    score -= 8;
    mismatches.push('Well below the buyer\'s stated budget — may read as a downgrade');
  }

  // Configuration.
  if (req.configurations?.length && row.configuration) {
    if (req.configurations.includes(row.configuration)) {
      score += 20;
      reasons.push(`${row.configuration} matches the requirement`);
    } else {
      // Adjacent configurations are a soft miss, not a hard one.
      const wantedBhk = req.configurations.map(bhkNumber).filter((n): n is number => n !== null);
      const actualBhk = bhkNumber(row.configuration);
      if (actualBhk !== null && wantedBhk.some((w) => Math.abs(w - actualBhk) <= 0.5)) {
        score += 5;
        mismatches.push(`${row.configuration} instead of ${req.configurations.join('/')}`);
      } else {
        score -= 12;
        mismatches.push(`${row.configuration} does not match the requested ${req.configurations.join('/')}`);
      }
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

  // Area. The buyer states one figure, so it is read as "about this much":
  // 15% either side counts as a match, well under is a miss.
  if (row.carpet_area && req.area) {
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
    const offered = toSqFt(row.carpet_area, row.area_unit);
    const ratio = offered / wanted;
    if (ratio >= 0.85 && ratio <= 1.15) {
      score += 8;
      reasons.push(
        `${formatArea(row.carpet_area, row.area_unit ?? 'sqft')} is about the `
        + `${formatArea(req.area, req.areaUnit)} asked for`,
      );
    } else if (ratio < 0.85) {
      score -= 8;
      mismatches.push(
        `${formatArea(row.carpet_area, row.area_unit ?? 'sqft')} is smaller than the `
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

  return {
    row,
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons: reasons.slice(0, 5),
    mismatches: mismatches.slice(0, 3),
  };
}

function bhkNumber(config: string): number | null {
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
  const candidates = await candidateInventory(req, 60, opts.scope);
  if (!candidates.length) return [];

  const scored = candidates
    .map((row) => scoreProperty(row, req))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 6);

  let matches: PropertyMatch[] = scored.map((s) => ({
    propertyId: s.row.record_id,
    propertyLabel: s.row.label || s.row.name,
    score: s.score,
    reasons: s.reasons,
    mismatches: s.mismatches,
    projectName: s.row.project_name ?? undefined,
    price: s.row.total_price ?? s.row.base_price ?? undefined,
    configuration: s.row.configuration ?? undefined,
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
- Configuration: ${req.configurations?.join(', ') || '—'}
- Preferred locations: ${req.locations?.join(', ') || '—'}
- Area: ${req.area ?? '—'} ${req.areaUnit ?? 'sqft'}
- Timeline: ${req.possessionTimeline ?? '—'}
- Purpose: ${req.purpose ?? 'Buy'}

Here are the shortlisted units with their computed fit scores:

${scored.map((s, i) => `### ${i + 1}. ${s.row.label} (score ${s.score})
- Project: ${s.row.project_name ?? '—'}
- Configuration: ${s.row.configuration ?? '—'}, ${formatArea(s.row.carpet_area, s.row.area_unit ?? 'sqft')} carpet
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
      propertyLabel: s.row.label || s.row.name,
      score: s.score,
      reasons: enriched?.reasons?.length ? enriched.reasons : s.reasons,
      mismatches: enriched?.mismatches?.length ? enriched.mismatches : s.mismatches,
      projectName: s.row.project_name ?? undefined,
      price: s.row.total_price ?? s.row.base_price ?? undefined,
      configuration: s.row.configuration ?? undefined,
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
function acceptableConfigurations(configuration: string | null): string[] {
  if (!configuration) return [];
  const wanted = bhkNumber(configuration);
  if (wanted === null) return [configuration];
  const out = new Set([configuration]);
  for (const step of [-1, -0.5, 0.5, 1]) {
    const near = wanted + step;
    if (near <= 0) continue;
    out.add(`${Number.isInteger(near) ? near : near.toFixed(1)} BHK`);
  }
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
  const { matchFloor } = await scoringThresholds();
  const property = await db.queryOne<PropertyRow>(
    `SELECT p.record_id, r.label, p.name, p.configuration, p.carpet_area, p.area_unit, p.total_price, p.base_price,
            p.floor, p.facing, p.vastu_compliant, p.status, p.possession_date, p.possession_status,
            p.locality, p.amenities, p.corner_unit, p.bedrooms,
            to_jsonb(p)->>'city'         AS city,
            to_jsonb(p)->>'project_name' AS project_name
     FROM ipy_e_properties p JOIN ipy_record r ON r.id = p.record_id
     WHERE p.record_id = $1`,
    [propertyId],
  );
  if (!property) return [];

  const price = property.total_price ?? property.base_price ?? 0;

  // One accumulator: the scope fragment appends its own params after these.
  const params = new SqlParams();
  const priceP = params.add(price);
  const configP = params.add(acceptableConfigurations(property.configuration));
  const localityP = params.add(property.locality ?? '');
  const scopeSql = scope
    ? await (async () => { const f = await recordScopeSql(scope, 'leads', params, false); return f ? `AND ${f}` : ''; })()
    : '';

  const leads = await db.query<{ record_id: string; label: string; owner_id: string | null; budget: number | null; budget_unit: string | null; area: number | null; area_unit: string | null; configuration: string[] | null; preferred_locations: string[] | null; possession_timeline: string | null; purpose: string | null; status: string; lost_reason: string | null }>(
    // Lost leads are in scope now; Junk never is. A wrong number, a broker
    // fishing or a test entry does not become a buyer because a unit appeared,
    // and `revivalReason` is what decides which of the Lost are worth raising.
    //
    // The budget bound is relaxed for them: somebody lost on price stated a
    // number *before* saying no, and the whole point is that this unit may now
    // sit under it — filtering on the same ±band as a live lead would drop
    // exactly the ones worth reviving.
    `SELECT l.record_id, r.label, r.owner_id, l.budget,
            l.budget_unit, l.area, l.area_unit,
            l.configuration, l.preferred_locations, l.possession_timeline, l.purpose,
            l.status, l.lost_reason
     FROM ipy_e_leads l JOIN ipy_record r ON r.id = l.record_id
     WHERE r.is_deleted = false AND l.is_converted = false
       AND l.status <> 'Junk'
       AND (
         l.status <> 'Lost'
           AND (l.budget IS NULL
             OR l.budget_unit IS NOT NULL AND l.budget_unit <> 'total' AND l.area IS NOT NULL
             OR (l.budget >= ${priceP} * 0.85 AND l.budget <= ${priceP} * 1.2))
         OR l.status = 'Lost' AND l.lost_reason IS NOT NULL
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
     ORDER BY (l.configuration ?| ${configP}::text[]) DESC,
              (l.preferred_locations ? ${localityP}) DESC,
              r.updated_at DESC
     LIMIT 400`,
    params.all(),
  );

  const buyers = leads.rows
    .map((lead) => {
      // Same normalisation as loadRequirement: a per-unit budget with a stated
      // area becomes the absolute figure the scorer compares.
      let budget: number | null = lead.budget;
      const unit = lead.budget_unit ?? 'total';
      if (budget != null && unit !== 'total' && lead.area != null) {
        const sqft = toSqFt(lead.area, lead.area_unit ?? 'sqft');
        const per = unit === 'sqft' ? budget : toSqFt(budget, 'sqyd');
        budget = Math.round(per * sqft);
      }
      const req: Requirement = {
        budget,
        configurations: lead.configuration ?? [],
        locations: lead.preferred_locations ?? [],
        possessionTimeline: lead.possession_timeline,
        purpose: lead.purpose,
      };
      const scored = scoreProperty(property, req);
      const revival = lead.status === 'Lost'
        ? revivalReason(lead.lost_reason, property, req)
        : null;

      return {
        wasLost: lead.status === 'Lost',
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
          budget: lead.budget,
          configuration: lead.configuration ?? [],
          preferredLocations: lead.preferred_locations ?? [],
          possessionTimeline: lead.possession_timeline,
          purpose: lead.purpose,
          status: lead.status,
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
- Configuration: ${property.configuration ?? '—'}, ${formatArea(property.carpet_area, property.area_unit ?? 'sqft')} carpet
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
