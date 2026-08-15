/**
 * What an assistant can do with iPropy.
 *
 * The tools are shaped around a working day, not around the API. "Find me the
 * buyers who match this unit" is one call because that is one thought; it is
 * not "list leads, then fetch each one, then compare budgets". A tool that
 * mirrors the REST surface makes the model do the reasoning a human already
 * did when they named the feature.
 *
 * Three rules hold across all of them:
 *
 *   Nothing here re-implements a permission check. Every call goes out through
 *   the CRM's own API as the key's owner, so a junior's assistant sees a
 *   junior's records — enforced in one place, by the code the web app uses.
 *
 *   Nothing here deletes. The server refuses it for API keys anyway (see
 *   routes/records.ts), but not offering the tool means a model never even
 *   forms the intention.
 *
 *   Writes say what they did, in the same words a person would use, and
 *   include the record's own number. An assistant that reports "updated
 *   successfully" gives you nothing to check; one that says "LD-00113 is now
 *   Site Visit Scheduled" gives you something to disagree with.
 */
import { z } from 'zod';
import type { CrmClient } from './client.js';
import {
  budgetRange, indianPrice, leadSummary, lines, list, propertySummary,
  type RecordEnvelope,
} from './format.js';

interface ListResponse {
  rows: RecordEnvelope[];
  total: number;
}

/** Today in the CRM's own date format, for date comparisons. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Every tool answers with text, plus a flag when it is reporting a failure.
 *
 * The index signature is the SDK's `CallToolResult` shape — it allows extra
 * top-level keys, and an interface without one is not assignable to it.
 */
export interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function text(body: string): ToolResult {
  return { content: [{ type: 'text', text: body }] };
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  schema: z.ZodRawShape;
  /** True for tools that change something — surfaced to the client for consent UI. */
  writes?: boolean;
  run: (crm: CrmClient, args: Record<string, unknown>) => Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const findLeads: ToolDef = {
  name: 'find_leads',
  title: 'Find leads and contacts',
  description:
    'Search leads and contacts by name, phone, email or free text, optionally narrowed by '
    + 'pipeline status, budget or the areas they want. Use this to answer "who is interested '
    + 'in X", "which leads have I not called", or to find one person before updating them.',
  schema: {
    query: z.string().optional().describe('Name, phone number, email or any text to search for'),
    status: z.enum([
      'New', 'Attempted Contact', 'Contacted', 'Qualified', 'Site Visit Scheduled',
      'Site Visit Done', 'Negotiation', 'Converted', 'Junk', 'Lost',
    ]).optional().describe('Pipeline status'),
    minBudget: z.number().optional().describe('Only leads whose maximum budget is at least this, in rupees'),
    maxBudget: z.number().optional().describe('Only leads whose minimum budget is at most this, in rupees'),
    area: z.string().optional().describe('A preferred locality, e.g. Powai'),
    limit: z.number().int().min(1).max(50).default(10).describe('How many to return'),
  },
  async run(crm, args) {
    const conditions: unknown[] = [];
    if (args.status) conditions.push({ field: 'status', operator: 'equals', value: args.status });
    if (typeof args.minBudget === 'number') conditions.push({ field: 'budget_max', operator: 'greater_or_equal', value: args.minBudget });
    if (typeof args.maxBudget === 'number') conditions.push({ field: 'budget_min', operator: 'less_or_equal', value: args.maxBudget });
    // preferred_locations is a multipicklist: `contains` is not one of its
    // operators, `has_any` is.
    if (args.area) conditions.push({ field: 'preferred_locations', operator: 'has_any', value: [args.area] });

    const res = await crm.search<ListResponse>('/api/records/leads/search', {
      search: args.query || undefined,
      filter: { logic: 'AND', conditions },
      pageSize: args.limit ?? 10,
      sortBy: 'ai_score',
      sortDir: 'desc',
    });

    return text(list(res.rows, res.total, (r) => leadSummary(r), 'No leads match that.'));
  },
};

const getLead: ToolDef = {
  name: 'get_lead',
  title: 'Open one lead',
  description:
    'Everything recorded about one lead or contact, including their requirement, their history '
    + 'and the last few things that happened. Needs the lead id, which find_leads returns.',
  schema: {
    leadId: z.string().describe('The lead id, as returned by find_leads'),
    includeHistory: z.boolean().default(true).describe('Include the recent timeline'),
  },
  async run(crm, args) {
    const row = await crm.get<RecordEnvelope>(`/api/records/leads/${args.leadId}`);
    let out = leadSummary(row, { full: true });

    if (args.includeHistory !== false) {
      try {
        const timeline = await crm.get<{ entries?: { type: string; title: string; created_at: string }[] }>(
          `/api/records/leads/${args.leadId}/timeline`,
        );
        const recent = (timeline.entries ?? []).slice(0, 8);
        if (recent.length) {
          out += `\n\nRecent activity:\n${recent
            .map((e) => `- ${new Date(e.created_at).toLocaleDateString('en-IN')} — ${e.title}`)
            .join('\n')}`;
        }
      } catch {
        // The lead itself is the answer; a timeline that will not load is not
        // a reason to fail the whole call.
      }
    }
    return text(out);
  },
};

const findProperties: ToolDef = {
  name: 'find_properties',
  title: 'Find units',
  description:
    'Search inventory by budget, configuration, locality or project. Defaults to units that '
    + 'are actually available. Use this for "what do we have under 2 crore in Powai".',
  schema: {
    query: z.string().optional().describe('Unit name, project name or any text'),
    maxPrice: z.number().optional().describe('Highest price in rupees, e.g. 20000000 for ₹2 Cr'),
    minPrice: z.number().optional().describe('Lowest price in rupees'),
    configuration: z.string().optional().describe('e.g. "3 BHK"'),
    locality: z.string().optional().describe('e.g. Powai'),
    includeUnavailable: z.boolean().default(false).describe('Include held, booked and sold units'),
    limit: z.number().int().min(1).max(50).default(10),
  },
  async run(crm, args) {
    const conditions: unknown[] = [];
    if (!args.includeUnavailable) conditions.push({ field: 'status', operator: 'equals', value: 'Available' });
    if (typeof args.maxPrice === 'number') conditions.push({ field: 'base_price', operator: 'less_or_equal', value: args.maxPrice });
    if (typeof args.minPrice === 'number') conditions.push({ field: 'base_price', operator: 'greater_or_equal', value: args.minPrice });
    if (args.configuration) conditions.push({ field: 'configuration', operator: 'equals', value: args.configuration });
    if (args.locality) conditions.push({ field: 'locality', operator: 'equals', value: args.locality });

    const res = await crm.search<ListResponse>('/api/records/properties/search', {
      search: args.query || undefined,
      filter: { logic: 'AND', conditions },
      pageSize: args.limit ?? 10,
      sortBy: 'base_price',
      sortDir: 'asc',
    });

    return text(list(res.rows, res.total, (r) => propertySummary(r), 'No units match that.'));
  },
};

const getProperty: ToolDef = {
  name: 'get_property',
  title: 'Open one unit',
  description: 'Everything recorded about one unit — price breakdown, area, floor, facing, possession.',
  schema: { propertyId: z.string().describe('The property id, as returned by find_properties') },
  async run(crm, args) {
    const row = await crm.get<RecordEnvelope>(`/api/records/properties/${args.propertyId}`);
    return text(propertySummary(row, { full: true }));
  },
};

const matchBuyers: ToolDef = {
  name: 'match_buyers_for_property',
  title: 'Who wants this unit',
  description:
    'Given a unit, rank the live buyers whose requirement it fits, with the reasons. '
    + 'This is the question to ask when new inventory arrives: who was waiting for this.',
  schema: {
    propertyId: z.string().describe('The property id'),
    limit: z.number().int().min(1).max(25).default(10),
  },
  async run(crm, args) {
    const res = await crm.get<{ buyers: { recordId: string; label: string; score: number; reasons: string[] }[] }>(
      `/api/ai/buyers-for/${args.propertyId}?limit=${args.limit ?? 10}`,
    );
    if (!res.buyers?.length) return text('No live buyers match this unit closely enough to be worth a call.');

    return text(
      `${res.buyers.length} buyer${res.buyers.length === 1 ? '' : 's'} match this unit.\n\n`
      + res.buyers.map((b, i) =>
        `${i + 1}. ${b.label} — ${b.score}% fit (id: ${b.recordId})`
        + (b.reasons.length ? `\n   ${b.reasons.slice(0, 3).join('\n   ')}` : ''),
      ).join('\n\n'),
    );
  },
};

const matchProperties: ToolDef = {
  name: 'match_properties_for_lead',
  title: 'What suits this buyer',
  description:
    'Given a lead, rank the available units that fit their budget, configuration, area and '
    + 'timeline, with the reasons. Use this before a call, or to answer "what can I send them".',
  schema: {
    leadId: z.string().describe('The lead id'),
    limit: z.number().int().min(1).max(25).default(5),
  },
  async run(crm, args) {
    const res = await crm.get<{ matches: { propertyId: string; propertyLabel: string; score: number; reasons: string[]; price?: number }[] }>(
      `/api/ai/match/leads/${args.leadId}?limit=${args.limit ?? 5}`,
    );
    const matches = res.matches ?? [];
    if (!matches.length) return text('Nothing in available inventory fits this buyer well right now.');

    return text(
      `${matches.length} unit${matches.length === 1 ? '' : 's'} suit this buyer.\n\n`
      + matches.map((m, i) =>
        `${i + 1}. ${m.propertyLabel} — ${m.score}% fit`
        + (m.price ? `, ${indianPrice(m.price)}` : '')
        + ` (id: ${m.propertyId})`
        + (m.reasons?.length ? `\n   ${m.reasons.slice(0, 3).join('\n   ')}` : ''),
      ).join('\n\n'),
    );
  },
};

const todaysFollowUps: ToolDef = {
  name: 'todays_follow_ups',
  title: "Today's follow-ups",
  description:
    'The leads due to be chased today or already overdue, most urgent first. This is the '
    + '"what should I do now" question.',
  schema: {
    includeOverdue: z.boolean().default(true).describe('Include follow-ups whose date has passed'),
    limit: z.number().int().min(1).max(50).default(20),
  },
  async run(crm, args) {
    const res = await crm.search<ListResponse>('/api/records/leads/search', {
      filter: {
        logic: 'AND',
        conditions: [
          args.includeOverdue === false
            ? { field: 'next_followup_at', operator: 'today' }
            // No `before_or_today` operator exists; "due or overdue" is
            // everything on or before today's date.
            : { field: 'next_followup_at', operator: 'less_or_equal', value: today() },
          { field: 'is_converted', operator: 'is_false' },
          { field: 'status', operator: 'not_in', value: ['Junk', 'Lost', 'Converted'] },
        ],
      },
      pageSize: args.limit ?? 20,
      sortBy: 'next_followup_at',
      sortDir: 'asc',
    });

    return text(list(
      res.rows, res.total,
      (r) => leadSummary(r),
      'Nothing is due today. Either you are on top of it, or nobody has set follow-up dates.',
    ));
  },
};

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const createLead: ToolDef = {
  name: 'create_lead',
  title: 'Add a lead',
  description:
    'Add a new enquiry. The CRM checks for duplicates, scores it, assigns an owner and runs '
    + 'the usual welcome workflow, exactly as if it had been typed in by hand. Give the mobile '
    + 'number as ten digits without the country code.',
  writes: true,
  schema: {
    fullName: z.string().min(1).describe("The person's full name"),
    mobile: z.string().min(1).describe('Ten digits, no country code, e.g. 9876543210'),
    email: z.string().optional(),
    budgetMin: z.number().optional().describe('In rupees, e.g. 15000000 for ₹1.5 Cr'),
    budgetMax: z.number().optional().describe('In rupees'),
    configuration: z.array(z.string()).optional().describe('e.g. ["2 BHK", "3 BHK"]'),
    preferredLocations: z.array(z.string()).optional(),
    interestedProject: z.string().optional(),
    source: z.string().optional().describe('Where they came from, e.g. Walk-in, Referral, Channel Partner'),
    notes: z.string().optional(),
  },
  async run(crm, args) {
    const digits = String(args.mobile ?? '').replace(/\D/g, '').slice(-10);
    if (digits.length !== 10) {
      return {
        content: [{ type: 'text', text: `"${String(args.mobile)}" is not a ten-digit Indian mobile number. Give the number without the country code, e.g. 9876543210.` }],
        isError: true,
      };
    }

    const created = await crm.post<{ id: string; recordNumber?: string; label: string }>('/api/records/leads', {
      full_name: args.fullName,
      mobile: digits,
      country_code: '+91',
      email: args.email,
      budget_min: args.budgetMin,
      budget_max: args.budgetMax,
      configuration: args.configuration,
      preferred_locations: args.preferredLocations,
      interested_project: args.interestedProject,
      lead_source: args.source,
      description: args.notes,
      lifecycle_stage: 'Lead',
      status: 'New',
    });

    return text(
      `Added ${created.label}${created.recordNumber ? ` as ${created.recordNumber}` : ''}.\n`
      + lines([
        ['Mobile', `+91 ${digits}`],
        ['Budget', budgetRange(args.budgetMin, args.budgetMax)],
        ['Wants', args.configuration],
        ['Areas', args.preferredLocations],
      ])
      + `\n\nid: ${created.id}`,
    );
  },
};

const updateLead: ToolDef = {
  name: 'update_lead',
  title: 'Update a lead',
  description:
    'Change a lead\'s pipeline status, next follow-up date, budget or requirement. Only the '
    + 'fields you pass are touched. Use get_lead first if you are not certain which lead this is.',
  writes: true,
  schema: {
    leadId: z.string().describe('The lead id'),
    status: z.enum([
      'New', 'Attempted Contact', 'Contacted', 'Qualified', 'Site Visit Scheduled',
      'Site Visit Done', 'Negotiation', 'Converted', 'Junk', 'Lost',
    ]).optional(),
    nextFollowUp: z.string().optional().describe('Date as YYYY-MM-DD'),
    budgetMin: z.number().optional(),
    budgetMax: z.number().optional(),
    configuration: z.array(z.string()).optional(),
    preferredLocations: z.array(z.string()).optional(),
    interestedProject: z.string().optional(),
  },
  async run(crm, args) {
    const patch: Record<string, unknown> = {};
    if (args.status) patch.status = args.status;
    if (args.nextFollowUp) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(args.nextFollowUp))) {
        return { content: [{ type: 'text', text: 'The follow-up date must be YYYY-MM-DD, e.g. 2026-08-20.' }], isError: true };
      }
      patch.next_followup_at = args.nextFollowUp;
    }
    if (typeof args.budgetMin === 'number') patch.budget_min = args.budgetMin;
    if (typeof args.budgetMax === 'number') patch.budget_max = args.budgetMax;
    if (args.configuration) patch.configuration = args.configuration;
    if (args.preferredLocations) patch.preferred_locations = args.preferredLocations;
    if (args.interestedProject) patch.interested_project = args.interestedProject;

    if (!Object.keys(patch).length) {
      return { content: [{ type: 'text', text: 'Nothing to change — pass at least one field.' }], isError: true };
    }

    const row = await crm.patch<RecordEnvelope>(`/api/records/leads/${args.leadId}`, patch);
    // Report back from the *saved* record, not from what was asked for: a
    // workflow or a validation rule may have adjusted it, and the person needs
    // to see what is actually stored.
    return text(`Updated ${row.label}${row.recordNumber ? ` (${row.recordNumber})` : ''}.\n${leadSummary(row)}`);
  },
};

const addNote: ToolDef = {
  name: 'add_note',
  title: 'Add a note',
  description:
    'Post a note on a lead or a unit — what was said on a call, what the buyer objected to, '
    + 'what was agreed. It appears on the record for the whole team and in the timeline.',
  writes: true,
  schema: {
    module: z.enum(['leads', 'properties']).default('leads'),
    recordId: z.string().describe('The record id'),
    note: z.string().min(1).max(10_000).describe('What to write'),
  },
  async run(crm, args) {
    await crm.post(`/api/records/${args.module ?? 'leads'}/${args.recordId}/comments`, { body: args.note });
    return text('Note added.');
  },
};

export const TOOLS: ToolDef[] = [
  findLeads,
  getLead,
  findProperties,
  getProperty,
  matchBuyers,
  matchProperties,
  todaysFollowUps,
  createLead,
  updateLead,
  addNote,
];

/** The read-only subset, for a connection that is not allowed to change anything. */
export function toolsFor(crm: CrmClient): ToolDef[] {
  return crm.readOnly ? TOOLS.filter((t) => !t.writes) : TOOLS;
}
