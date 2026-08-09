/**
 * Property matching.
 *
 * A deterministic scorer ranks available inventory against a buyer's stated
 * requirement (budget, configuration, area, location, possession). The LLM then
 * writes the *reasoning* — why this unit suits this buyer — which is what a rep
 * actually pastes into a WhatsApp message.
 */
import type { PropertyMatch } from '@ipropy/shared';
import { formatArea, formatIndianPrice } from '@ipropy/shared';
import { db } from '../db/pool.js';
import { completeJson, isAiAvailable, saveInsight, REAL_ESTATE_SYSTEM } from './client.js';

export interface Requirement {
  budgetMin?: number | null;
  budgetMax?: number | null;
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

interface PropertyRow {
  record_id: string;
  label: string;
  name: string;
  configuration: string | null;
  carpet_area: number | null;
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
  const lead = await db.queryOne<Record<string, unknown>>(
    `SELECT budget_min, budget_max, configuration, preferred_locations,
            area, area_unit, possession_timeline, interested_project, purpose
     FROM ipy_e_leads WHERE record_id = $1`,
    [recordId],
  );
  if (lead) {
    return {
      budgetMin: lead.budget_min as number | null,
      budgetMax: lead.budget_max as number | null,
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

async function candidateInventory(req: Requirement, limit = 60): Promise<PropertyRow[]> {
  // Allow 10% headroom over the stated ceiling — buyers routinely stretch.
  const maxPrice = req.budgetMax ? req.budgetMax * 1.1 : null;
  const minPrice = req.budgetMin ? req.budgetMin * 0.8 : null;

  const res = await db.query<PropertyRow>(
    `SELECT p.record_id, r.label, p.name, p.configuration, p.carpet_area, p.total_price,
            p.base_price, p.floor, p.facing, p.vastu_compliant, p.status,
            p.possession_date, p.possession_status, p.city, p.locality,
            p.amenities, p.corner_unit, p.bedrooms, p.project_name
     FROM ipy_e_properties p
     JOIN ipy_record r ON r.id = p.record_id
     WHERE r.is_deleted = false
       AND p.status = 'Available'
       AND ($1::numeric IS NULL OR COALESCE(p.total_price, p.base_price) <= $1)
       AND ($2::numeric IS NULL OR COALESCE(p.total_price, p.base_price) >= $2)
       AND ($3::text IS NULL OR p.project_name ILIKE $3)
     ORDER BY COALESCE(p.total_price, p.base_price) ASC
     LIMIT $4`,
    [maxPrice, minPrice, req.projectName ?? null, limit],
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
  if (req.budgetMax && price) {
    const ratio = price / req.budgetMax;
    if (ratio <= 0.9) { score += 22; reasons.push(`${formatIndianPrice(price)} sits comfortably under the ${formatIndianPrice(req.budgetMax)} budget`); }
    else if (ratio <= 1.0) { score += 18; reasons.push(`${formatIndianPrice(price)} fits the stated budget`); }
    else if (ratio <= 1.05) { score += 6; mismatches.push(`${Math.round((ratio - 1) * 100)}% above budget — negotiable`); }
    else { score -= 15; mismatches.push(`${formatIndianPrice(price)} exceeds the budget by ${Math.round((ratio - 1) * 100)}%`); }
  }
  if (req.budgetMin && price && price < req.budgetMin * 0.7) {
    score -= 8;
    mismatches.push('Well below the buyer\'s stated range — may read as a downgrade');
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
    const ratio = row.carpet_area / req.area;
    if (ratio >= 0.85 && ratio <= 1.15) {
      score += 8;
      reasons.push(`${formatArea(row.carpet_area)} is about the ${formatArea(req.area)} asked for`);
    } else if (ratio < 0.85) {
      score -= 8;
      mismatches.push(`${formatArea(row.carpet_area)} is smaller than the ${formatArea(req.area)} asked for`);
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
}

export async function matchProperties(
  req: Requirement,
  opts: MatchOptions = {},
): Promise<PropertyMatch[]> {
  const candidates = await candidateInventory(req);
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
- Budget: ${req.budgetMin ? formatIndianPrice(req.budgetMin) : '—'} to ${req.budgetMax ? formatIndianPrice(req.budgetMax) : '—'}
- Configuration: ${req.configurations?.join(', ') || '—'}
- Preferred locations: ${req.locations?.join(', ') || '—'}
- Area: ${req.area ?? '—'} ${req.areaUnit ?? 'sqft'}
- Timeline: ${req.possessionTimeline ?? '—'}
- Purpose: ${req.purpose ?? 'Buy'}

Here are the shortlisted units with their computed fit scores:

${scored.map((s, i) => `### ${i + 1}. ${s.row.label} (score ${s.score})
- Project: ${s.row.project_name ?? '—'}
- Configuration: ${s.row.configuration ?? '—'}, ${s.row.carpet_area ?? '—'} sq.ft carpet
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
 * Reverse match: given a property, which open leads should be pitched it?
 * Used when a unit is released or repriced.
 */
export async function matchBuyersForProperty(propertyId: string, limit = 10): Promise<{
  recordId: string; label: string; module: string; score: number; ownerId: string | null; reasons: string[];
}[]> {
  const property = await db.queryOne<PropertyRow>(
    `SELECT p.record_id, r.label, p.name, p.configuration, p.carpet_area, p.total_price, p.base_price,
            p.floor, p.facing, p.vastu_compliant, p.status, p.possession_date, p.possession_status,
            p.city, p.locality, p.amenities, p.corner_unit, p.bedrooms, p.project_name
     FROM ipy_e_properties p JOIN ipy_record r ON r.id = p.record_id
     WHERE p.record_id = $1`,
    [propertyId],
  );
  if (!property) return [];

  const price = property.total_price ?? property.base_price ?? 0;

  const leads = await db.query<{ record_id: string; label: string; owner_id: string | null; budget_min: number | null; budget_max: number | null; configuration: string[] | null; preferred_locations: string[] | null; possession_timeline: string | null; purpose: string | null }>(
    `SELECT l.record_id, r.label, r.owner_id, l.budget_min, l.budget_max,
            l.configuration, l.preferred_locations, l.possession_timeline, l.purpose
     FROM ipy_e_leads l JOIN ipy_record r ON r.id = l.record_id
     WHERE r.is_deleted = false AND l.is_converted = false
       AND l.status NOT IN ('Junk','Lost')
       AND (l.budget_max IS NULL OR l.budget_max >= $1 * 0.85)
       AND (l.budget_min IS NULL OR l.budget_min <= $1 * 1.2)
     ORDER BY l.ai_score DESC NULLS LAST
     LIMIT 200`,
    [price],
  );

  return leads.rows
    .map((lead) => {
      const scored = scoreProperty(property, {
        budgetMin: lead.budget_min,
        budgetMax: lead.budget_max,
        configurations: lead.configuration ?? [],
        locations: lead.preferred_locations ?? [],
        possessionTimeline: lead.possession_timeline,
        purpose: lead.purpose,
      });
      return {
        recordId: lead.record_id,
        label: lead.label,
        module: 'leads',
        score: scored.score,
        ownerId: lead.owner_id,
        reasons: scored.reasons,
      };
    })
    .filter((m) => m.score >= 55)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
