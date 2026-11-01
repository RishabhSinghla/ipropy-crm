/**
 * "What earns money" — which channel, template and agent move contacts forward.
 *
 * A *touch* is something we did to a contact: an outbound message on any
 * channel, or an outbound call. An *outcome* is the contact's status moving
 * into one of the stages below (read from the audit trail). Each outcome is
 * credited to the LAST touch before it inside the attribution window, so one
 * Visit Done is never counted for three messages. This is correlation, not
 * proof, and the screen says so.
 *
 * Channels are plain strings (`whatsapp_api`, `whatsapp_chat`, `call`, `sms`,
 * `email`, ...). A new provider shows up here with no change, because the
 * channel comes from the message row itself.
 */
import { db } from '../../db/pool.js';
import { columnsOf, fieldText } from '../entity/payloadColumns.js';

export const STAGES = {
  qualified: ['Qualified', 'Contacted'],
  visitFixed: ['Visit Fixed', 'Visit Scheduled'],
  visitDone: ['Visit Done'],
  won: ['Won', 'Deal Won', 'Converted'],
} as const;
export type StageKey = keyof typeof STAGES;
const STAGE_KEYS = Object.keys(STAGES) as StageKey[];

export interface RoiQuery {
  from: Date;
  to: Date;
  windowDays: number;
  source?: string;
  agentId?: string;
}

export interface CostSettings {
  /** Rupees per delivered message, by WhatsApp category. */
  whatsappMarketing: number;
  whatsappUtility: number;
  /** What the provider charges per message sent, on top of Meta. */
  providerFee: number;
  /** Flat rupees per message for channels without categories (sms, email, rcs). */
  otherPerMessage: number;
}

export const DEFAULT_COSTS: CostSettings = {
  whatsappMarketing: 0.86,
  whatsappUtility: 0.115,
  providerFee: 0,
  otherPerMessage: 0,
};

export async function readCosts(): Promise<CostSettings> {
  try {
    const row = await db.queryOne<{ value: unknown }>(`SELECT value FROM ipy_setting WHERE key = 'roi.costs'`);
    const v = (row?.value ?? {}) as Partial<CostSettings>;
    const num = (x: unknown, d: number): number => (typeof x === 'number' && x >= 0 ? x : d);
    return {
      whatsappMarketing: num(v.whatsappMarketing, DEFAULT_COSTS.whatsappMarketing),
      whatsappUtility: num(v.whatsappUtility, DEFAULT_COSTS.whatsappUtility),
      providerFee: num(v.providerFee, DEFAULT_COSTS.providerFee),
      otherPerMessage: num(v.otherPerMessage, DEFAULT_COSTS.otherPerMessage),
    };
  } catch {
    return DEFAULT_COSTS;
  }
}

interface TouchRow {
  id: string;
  record_id: string | null;
  channel: string;
  template: string | null;
  category: string | null;
  status: string;
  error_message: string | null;
  agent_id: string | null;
  replied: boolean;
  delivered: boolean;
  read: boolean;
  answered: boolean;
  current_status: string | null;
  stages: string[];
}

export interface Counts {
  touches: number;
  calls: number;
  messages: number;
  leads: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  answered: number;
  qualified: number;
  visitFixed: number;
  visitDone: number;
  won: number;
  /** Contacts touched in this period whose status is, today, a visit stage / won (history may not be in the audit trail). */
  nowVisit: number;
  nowWon: number;
  /** Rupees for the touches whose price is known. */
  cost: number;
  /** Touches we could not price (unknown template category). */
  costUnknown: number;
}

const blank = (): Counts => ({
  touches: 0, calls: 0, messages: 0, leads: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, answered: 0,
  qualified: 0, visitFixed: 0, visitDone: 0, won: 0, nowVisit: 0, nowWon: 0, cost: 0, costUnknown: 0,
});

/** Template names end in _mkt / _utl in this business; Meta's own label wins when the sync has one. */
export function templateCategory(name: string | null, synced: string | null): 'marketing' | 'utility' | 'unknown' {
  const s = (synced ?? '').toUpperCase();
  if (s === 'MARKETING') return 'marketing';
  if (s === 'UTILITY') return 'utility';
  if (name && /_mkt$/i.test(name)) return 'marketing';
  if (name && /_utl$/i.test(name)) return 'utility';
  return 'unknown';
}

export function failureReason(message: string | null): string {
  if (!message) return 'No reason given';
  const code = /Error Code\s*:\s*(\d+)/i.exec(message);
  if (code) return `Meta ${code[1]}${code[1] === '131049' ? ' (marketing limit per person)' : ''}`;
  return message.length > 70 ? `${message.slice(0, 70)}…` : message;
}

function touchCost(t: TouchRow, c: CostSettings): number | null {
  if (t.channel === 'whatsapp_api') {
    if (t.status === 'failed' || t.status === 'queued') return 0;
    const rate = t.category === 'marketing' ? c.whatsappMarketing : t.category === 'utility' ? c.whatsappUtility : null;
    if (rate === null) return t.delivered ? null : c.providerFee;
    return (t.delivered ? rate : 0) + c.providerFee;
  }
  if (t.channel === 'whatsapp_chat' || t.channel === 'call') return 0;
  return t.status === 'failed' ? 0 : c.otherPerMessage;
}

function rollup(rows: TouchRow[], costs: CostSettings): Counts {
  const out = blank();
  const leads = new Set<string>();
  const stageLeads: Record<StageKey, Set<string>> = { qualified: new Set(), visitFixed: new Set(), visitDone: new Set(), won: new Set() };
  for (const t of rows) {
    out.touches += 1;
    if (t.channel === 'call') out.calls += 1;
    else out.messages += 1;
    if (t.record_id) leads.add(t.record_id);
    if (t.status !== 'queued') out.sent += 1;
    if (t.status === 'failed') out.failed += 1;
    if (t.delivered) out.delivered += 1;
    if (t.read) out.read += 1;
    if (t.replied) out.replied += 1;
    if (t.answered) out.answered += 1;
    for (const s of t.stages) {
      if (t.record_id && (STAGE_KEYS as string[]).includes(s)) stageLeads[s as StageKey].add(t.record_id);
    }
    const c = touchCost(t, costs);
    if (c === null) out.costUnknown += 1;
    else out.cost += c;
  }
  out.leads = leads.size;
  const nowVisit = new Set<string>();
  const nowWon = new Set<string>();
  for (const t of rows) {
    if (!t.record_id || !t.current_status) continue;
    if (([...STAGES.visitFixed, ...STAGES.visitDone] as string[]).includes(t.current_status)) nowVisit.add(t.record_id);
    if ((STAGES.won as readonly string[]).includes(t.current_status)) nowWon.add(t.record_id);
  }
  out.nowVisit = nowVisit.size;
  out.nowWon = nowWon.size;
  for (const k of STAGE_KEYS) out[k] = stageLeads[k].size;
  return out;
}

async function loadTouches(q: RoiQuery): Promise<TouchRow[]> {
  // Read through the helpers: an admin may delete these fields, and a bare column would then be a 42703.
  const present = await columnsOf('ipy_e_leads');
  const leadStatus = fieldText(present, 'l', 'status');
  const leadSource = fieldText(present, 'l', 'lead_source');
  const stageCases = STAGE_KEYS.map((k) => `WHEN c.val = ANY(ARRAY[${STAGES[k].map((s) => `'${s}'`).join(',')}]) THEN '${k}'`).join(' ');
  const { rows } = await db.query<TouchRow>(
    `WITH touches AS MATERIALIZED (
       SELECT m.id::text AS id, c.record_id, m.created_at AS ts,
              CASE WHEN m.channel = 'whatsapp' THEN (CASE WHEN m.provider = 'whatsapp_openwa' THEN 'whatsapp_chat' ELSE 'whatsapp_api' END)
                   ELSE m.channel END AS channel,
              m.template_name AS template, t.category AS category, m.status, m.error_message,
              COALESCE(m.sent_by, wn.user_id, r.owner_id) AS agent_id,
              EXISTS (SELECT 1 FROM ipy_message i
                       WHERE i.conversation_id = m.conversation_id AND i.direction = 'inbound'
                         AND i.created_at > m.created_at
                         AND i.created_at <= m.created_at + make_interval(days => $3::int)) AS replied,
              (m.status IN ('delivered','read') OR m.delivered_at IS NOT NULL) AS delivered,
              (m.status = 'read' OR m.read_at IS NOT NULL) AS read,
              false AS answered, ${leadStatus} AS current_status
         FROM ipy_message m
         JOIN ipy_conversation c ON c.id = m.conversation_id
         LEFT JOIN ipy_record r ON r.id = c.record_id
         LEFT JOIN ipy_wa_number wn ON wn.id = m.number_id
         LEFT JOIN ipy_e_leads l ON l.record_id = c.record_id
         LEFT JOIN LATERAL (SELECT category FROM ipy_whatsapp_template w WHERE w.name = m.template_name LIMIT 1) t ON true
        WHERE m.direction = 'outbound' AND m.created_at >= $1 AND m.created_at < $2
          AND ($4::text IS NULL OR ${leadSource} = $4)
          AND ($5::uuid IS NULL OR COALESCE(m.sent_by, wn.user_id, r.owner_id) = $5)
       UNION ALL
       SELECT k.id::text, k.record_id, k.started_at, 'call', NULL, NULL,
              CASE WHEN k.status = 'failed' THEN 'failed' ELSE 'sent' END, NULL, k.user_id, false,
              false, false, (k.duration_seconds > 0 OR k.answered_at IS NOT NULL), ${leadStatus}
         FROM ipy_call k
         LEFT JOIN ipy_e_leads l ON l.record_id = k.record_id
        WHERE k.direction = 'outbound' AND k.started_at >= $1 AND k.started_at < $2
          AND ($4::text IS NULL OR ${leadSource} = $4)
          AND ($5::uuid IS NULL OR k.user_id = $5)
     ), ev AS (
       SELECT a.record_id, a.created_at AS ts,
              CASE ${stageCases} END AS stage
         FROM ipy_audit a
         CROSS JOIN LATERAL (SELECT ch->>'to' AS val FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a.changes) = 'array' THEN a.changes ELSE '[]'::jsonb END) ch WHERE ch->>'field' = 'status') c
        WHERE a.module_name = 'leads' AND a.record_id IS NOT NULL
          AND a.created_at >= $1 AND a.created_at < $2 + make_interval(days => $3::int)
     ), cred AS MATERIALIZED (
       SELECT x.touch_id, e.stage, e.record_id
         FROM ev e
         CROSS JOIN LATERAL (
           SELECT t.id AS touch_id FROM touches t
            WHERE t.record_id = e.record_id AND t.ts <= e.ts AND t.ts >= e.ts - make_interval(days => $3::int)
            ORDER BY t.ts DESC LIMIT 1) x
        WHERE e.stage IS NOT NULL
     )
     SELECT t.id, t.record_id, t.channel, t.template, t.category, t.status, t.error_message, t.agent_id,
            t.replied, t.delivered, t.read, t.answered, t.current_status,
            COALESCE(cs.stages, '[]'::jsonb) AS stages
       FROM touches t
       LEFT JOIN (SELECT touch_id, jsonb_agg(DISTINCT stage) AS stages FROM cred GROUP BY touch_id) cs ON cs.touch_id = t.id`,
    [q.from, q.to, q.windowDays, q.source ?? null, q.agentId ?? null],
  );
  return rows;
}

function groupBy<T>(rows: T[], key: (r: T) => string | null): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (k === null) continue;
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

export async function buildRoiReport(q: RoiQuery): Promise<Record<string, unknown>> {
  const costs = await readCosts();
  const spanMs = q.to.getTime() - q.from.getTime();
  const prevQ: RoiQuery = { ...q, from: new Date(q.from.getTime() - spanMs), to: q.from };

  const [rows, prevRows] = await Promise.all([loadTouches(q), loadTouches(prevQ)]);
  const tagged = rows.map((r) => ({
    ...r,
    category: r.channel === 'whatsapp_api' && r.template ? templateCategory(r.template, r.category) : null,
  }));

  const channels = [...groupBy(tagged, (r) => r.channel)].map(([channel, list]) => ({
    channel, ...rollup(list, costs),
    topFailures: topFailures(list),
  })).sort((a, b) => b.touches - a.touches);

  const templates = [...groupBy(tagged, (r) => r.template)].map(([template, list]) => ({
    template, category: list[0]?.category ?? 'unknown', ...rollup(list, costs),
    topFailures: topFailures(list),
  })).sort((a, b) => b.sent - a.sent);

  const agentIds = [...new Set(tagged.map((r) => r.agent_id).filter((x): x is string => Boolean(x)))];
  const names = agentIds.length
    ? (await db.query<{ id: string; name: string }>(
        `SELECT id, trim(first_name || ' ' || last_name) AS name FROM ipy_user WHERE id = ANY($1::uuid[])`, [agentIds])).rows
    : [];
  const nameOf = new Map(names.map((n) => [n.id, n.name || 'Unnamed']));
  const response = await responseTimes(q);
  const agents = [...groupBy(tagged, (r) => r.agent_id ?? 'none')].map(([id, list]) => ({
    agentId: id === 'none' ? null : id,
    agent: id === 'none' ? 'Automatic / no agent' : (nameOf.get(id) ?? 'Unknown'),
    ...rollup(list, costs),
    medianResponseMinutes: response.get(id) ?? null,
  })).sort((a, b) => b.touches - a.touches);

  return {
    range: { from: q.from.toISOString(), to: q.to.toISOString(), windowDays: q.windowDays },
    stages: STAGES,
    costs,
    total: rollup(tagged, costs),
    previous: rollup(prevRows.map((r) => ({ ...r, category: r.channel === 'whatsapp_api' && r.template ? templateCategory(r.template, r.category) : null })), costs),
    channels, templates, agents,
  };
}

function topFailures(list: TouchRow[]): { reason: string; count: number }[] {
  const m = new Map<string, number>();
  for (const t of list) if (t.status === 'failed') m.set(failureReason(t.error_message), (m.get(failureReason(t.error_message)) ?? 0) + 1);
  return [...m].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 3);
}

/** Median minutes from a customer's message to the next human reply, per agent (capped at 3 days). */
async function responseTimes(q: RoiQuery): Promise<Map<string, number>> {
  const { rows } = await db.query<{ agent: string; minutes: number }>(
    `SELECT o.sent_by::text AS agent,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (o.created_at - i.created_at)) / 60) AS minutes
       FROM ipy_message i
       CROSS JOIN LATERAL (
         SELECT x.sent_by, x.created_at FROM ipy_message x
          WHERE x.conversation_id = i.conversation_id AND x.direction = 'outbound'
            AND x.sent_by IS NOT NULL AND x.created_at > i.created_at
            AND x.created_at <= i.created_at + interval '3 days'
          ORDER BY x.created_at LIMIT 1) o
      WHERE i.direction = 'inbound' AND i.created_at >= $1 AND i.created_at < $2
        AND ($3::uuid IS NULL OR o.sent_by = $3)
      GROUP BY o.sent_by`,
    [q.from, q.to, q.agentId ?? null],
  );
  return new Map(rows.map((r) => [r.agent, Math.round(Number(r.minutes))]));
}

export async function roiFilterOptions(): Promise<{ sources: string[]; agents: { id: string; name: string }[] }> {
  const present = await columnsOf('ipy_e_leads');
  const src = fieldText(present, 'l', 'lead_source');
  const [s, a] = await Promise.all([
    db.query<{ lead_source: string }>(`SELECT DISTINCT ${src} AS lead_source FROM ipy_e_leads l WHERE ${src} IS NOT NULL ORDER BY 1`),
    db.query<{ id: string; name: string }>(
      `SELECT id, trim(first_name || ' ' || last_name) AS name FROM ipy_user WHERE is_active ORDER BY 2`),
  ]);
  return { sources: s.rows.map((r) => r.lead_source), agents: a.rows };
}
