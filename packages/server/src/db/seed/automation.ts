import type { Tx } from '../pool.js';
import { config } from '../../config.js';

/**
 * Out-of-the-box automation. Each of these is an ordinary workflow row that an
 * admin can open, edit or switch off in the UI — nothing here is privileged.
 */

interface TaskSeed {
  type: string;
  name: string;
  delayMinutes?: number;
  delayField?: string;
  delayDirection?: 'before' | 'after';
  config: Record<string, unknown>;
}

interface WorkflowSeed {
  module: string;
  name: string;
  description: string;
  trigger: string;
  watchFields?: string[];
  conditions?: unknown;
  executionMode?: 'always' | 'once' | 'once_until_false';
  schedule?: Record<string, unknown>;
  active?: boolean;
  tasks: TaskSeed[];
}

const WORKFLOWS: WorkflowSeed[] = [
  // --- Lead intake -----------------------------------------------------------
  /*
    "Instant lead response" was here and was removed on 17 September 2026, on
    the owner's instruction, along with the WhatsApp leftovers of the day.

    Worth recording what went with it, because it was more than its WhatsApp
    step: the rule also scored each new enquiry and raised a "call this lead
    within 30 minutes" task for its owner. New leads get neither now. That was
    stated plainly and chosen anyway — it is not an oversight to be helpfully
    restored by the next person reading this file.
  */
  {
    module: 'leads',
    name: 'Auto-assign inbound leads',
    description: 'Routes unowned leads to the right team using the active assignment rules.',
    trigger: 'on_create',
    conditions: { logic: 'AND', conditions: [{ field: 'owner_id', operator: 'is_empty' }] },
    tasks: [{ type: 'assign_owner', name: 'Apply assignment rules', config: { strategy: 'rules' } }],
  },
  {
    module: 'leads',
    name: 'Escalate untouched leads',
    description: 'If nobody has contacted a new lead in 2 hours, tell the manager.',
    trigger: 'scheduled',
    schedule: { frequency: 'hourly' },
    conditions: {
      logic: 'AND',
      conditions: [
        { field: 'status', operator: 'equals', value: 'New' },
        { field: 'created_at', operator: 'older_than_n_days', value: 0.084 },
        { field: 'is_converted', operator: 'is_false' },
      ],
    },
    tasks: [
      { type: 'notify_user', name: 'Notify reporting manager', config: { to: 'owner_manager', title: 'Lead not contacted', body: '{{full_name}} has been sitting untouched for over 2 hours.' } },
      { type: 'add_tag', name: 'Tag as SLA breach', config: { tags: ['sla-breach'] } },
    ],
  },
  {
    module: 'leads',
    name: 'Nurture cold leads',
    description: 'Weekly re-engagement for leads with no activity in 14 days.',
    trigger: 'scheduled',
    schedule: { frequency: 'weekly', daysOfWeek: [2], time: '10:00' },
    conditions: {
      logic: 'AND',
      conditions: [
        { field: 'is_converted', operator: 'is_false' },
        { field: 'status', operator: 'not_in', value: ['Junk', 'Lost', 'Converted'] },
        { field: 'last_activity_at', operator: 'older_than_n_days', value: 14 },
      ],
    },
    tasks: [
      {
        type: 'ai_action', name: 'Draft a personalised nudge',
        config: { action: 'draft_message', channel: 'sms', tone: 'warm', goal: 'revive interest with a relevant new inventory or price update' },
      },
    ],
  },
  {
    module: 'leads',
    name: 'Re-score on engagement',
    description: 'Recomputes the AI score whenever the lead\'s status or requirement changes.',
    trigger: 'on_field_change',
    watchFields: ['status', 'budget', 'possession_timeline', 'interested_project', 'funding_type'],
    tasks: [{ type: 'ai_action', name: 'Re-score', config: { action: 'score_lead' } }],
  },

  // --- Site visits -----------------------------------------------------------

  // --- Deals -----------------------------------------------------------------

  // --- Bookings & payments ---------------------------------------------------

  // --- Inventory -------------------------------------------------------------
  {
    module: 'properties',
    name: 'Alert buyers waiting for new stock',
    description: 'When a unit is listed, tells each rep which of their buyers were waiting for exactly this. Whoever calls first sells it, so this is the alert that has to be automatic.',
    trigger: 'on_create',
    conditions: { logic: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'Available' }] },
    tasks: [{ type: 'ai_action', name: 'Match and alert', config: { action: 'match_buyers' } }],
  },
  {
    module: 'properties',
    name: 'Re-alert when a unit is repriced or returns',
    description: 'A price cut brings a different set of buyers into range, and an expired hold puts the unit back on the market. Both are new news to somebody — the action only alerts buyers it has not already named for this unit.',
    trigger: 'on_field_change',
    watchFields: ['status', 'total_price', 'base_price', 'possession_status'],
    conditions: { logic: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'Available' }] },
    tasks: [{ type: 'ai_action', name: 'Match and alert', config: { action: 'match_buyers' } }],
  },
  {
    module: 'properties',
    name: 'Release expired blocks',
    description: 'Frees units whose hold period has elapsed so stock never silently disappears.',
    trigger: 'scheduled',
    schedule: { frequency: 'hourly' },
    conditions: {
      logic: 'AND',
      conditions: [
        { field: 'status', operator: 'in', value: ['Held', 'Blocked'] },
        { field: 'blocked_until', operator: 'older_than_n_days', value: 0 },
      ],
    },
    tasks: [
      { type: 'update_fields', name: 'Release the unit', config: { values: { status: 'Available', blocked_until: null, blocked_for_lead_id: null } } },
      { type: 'notify_user', name: 'Tell the rep', config: { to: 'record_owner', title: 'Unit hold expired', body: '{{name}} has been released back to available inventory.' } },
    ],
  },

  /*
    There was a "Birthday greeting" here, and it is gone on the owner's
    instruction: "get rid of this birthday thing forever, we won't be using it
    ever in this life in the CRM." 16 September 2026.

    Worth keeping the reason it went, because it is not a matter of taste. Its
    condition — `date_of_birth is today` — was missing from the live row, so a
    daily rule with a WhatsApp step matched every contact in the database. It
    queued 20,006 messages on 13 September and 20,000 more on the 16th, 40,515
    waiting in total, 20,209 people holding two each. Nobody received one only
    because no WhatsApp Business account is connected, which is luck rather
    than a safeguard.

    Do not reintroduce it. A greeting nobody asked for, sent to a list this
    size, is one empty condition away from being a broadcast.
  */
];

export async function seedWorkflows(conn: Tx): Promise<void> {
  for (const [i, wf] of WORKFLOWS.entries()) {
    const mod = await conn.queryOne<{ id: string }>(`SELECT id FROM ipy_module WHERE name = $1`, [wf.module]);
    if (!mod) continue;

    const existing = await conn.queryOne<{ id: string }>(
      `SELECT id FROM ipy_workflow WHERE module_id = $1 AND name = $2`,
      [mod.id, wf.name],
    );

    // Create-only, and the most important one on this list. The old code reset
    // `is_active` from the definition and deleted every task row before putting
    // the seeded ones back — so a workflow an admin had switched off came back
    // on at the next cold start and started sending WhatsApp messages to real
    // customers again. Editing or disabling one of these is explicitly
    // supported (see the note at the top of this file), so the seed must leave
    // an existing row alone entirely.
    if (existing) continue;

    const params = [
      mod.id, wf.name, wf.description, wf.trigger,
      JSON.stringify(wf.watchFields ?? []),
      JSON.stringify(wf.conditions ?? { logic: 'AND', conditions: [] }),
      wf.executionMode ?? 'always',
      wf.schedule ? JSON.stringify(wf.schedule) : null,
      wf.active !== false, i,
    ];

    const row = await conn.queryOne<{ id: string }>(
      `INSERT INTO ipy_workflow
        (module_id, name, description, trigger, watch_fields, conditions,
         execution_mode, schedule, is_active, sequence, is_system)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)
       RETURNING id`,
      params,
    );
    const workflowId = row!.id;

    for (const [j, task] of wf.tasks.entries()) {
      await conn.query(
        `INSERT INTO ipy_workflow_task
          (workflow_id, type, name, sequence, delay_minutes, delay_field, delay_direction, config)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [workflowId, task.type, task.name, j, task.delayMinutes ?? 0, task.delayField ?? null, task.delayDirection ?? null, JSON.stringify(task.config)],
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Assignment rules
// ---------------------------------------------------------------------------

export async function seedAssignmentRules(conn: Tx): Promise<void> {
  const leads = await conn.queryOne<{ id: string }>(`SELECT id FROM ipy_module WHERE name = 'leads'`);
  if (!leads) return;

  /*
    Demo-group targeting only on demo installs. On a real org no such groups
    exist (migration 101 removed them), and a rule with a null target group
    would fall back to the pool's first user on every match — which is not a
    decision this org made. Fresh demo databases still get the full showcase.
  */
  const demoGroups = config.seed.demoData;
  const insideSales = demoGroups
    ? await conn.queryOne<{ id: string }>(`SELECT id FROM ipy_group WHERE name = 'Inside Sales'`)
    : null;
  const fieldSales = demoGroups
    ? await conn.queryOne<{ id: string }>(`SELECT id FROM ipy_group WHERE name = 'Field Sales — West'`)
    : null;

  const rules = [
    {
      name: 'High-value leads to field sales',
      conditions: { logic: 'AND', conditions: [{ field: 'budget', operator: 'greater_or_equal', value: 15000000 }] },
      strategy: 'load_balanced',
      groupId: fieldSales?.id ?? null,
      sequence: 0,
    },
    {
      name: 'Channel partner leads to CP manager',
      conditions: { logic: 'AND', conditions: [{ field: 'lead_source', operator: 'equals', value: 'Channel Partner' }] },
      strategy: 'round_robin',
      groupId: fieldSales?.id ?? null,
      sequence: 1,
    },
    {
      name: 'Everything else round-robin to inside sales',
      conditions: { logic: 'AND', conditions: [] },
      strategy: 'round_robin',
      groupId: insideSales?.id ?? null,
      sequence: 2,
    },
  ];

  for (const r of rules) {
    const existing = await conn.queryOne<{ id: string }>(
      `SELECT id FROM ipy_assignment_rule WHERE module_id = $1 AND name = $2`,
      [leads.id, r.name],
    );
    // Create-only, like the SLA policies below. Who a lead routes to is a
    // business decision an admin makes in the UI; re-seeding it put the
    // out-of-the-box routing back and leads started landing on the wrong desk.
    if (existing) continue;
    await conn.query(
      `INSERT INTO ipy_assignment_rule (module_id, name, conditions, strategy, target_group_id, sequence)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [leads.id, r.name, JSON.stringify(r.conditions), r.strategy, r.groupId, r.sequence],
    );
  }
}

// ---------------------------------------------------------------------------
// SLA policies
// ---------------------------------------------------------------------------

export async function seedSlaPolicies(conn: Tx): Promise<void> {
  const leads = await conn.queryOne<{ id: string }>(`SELECT id FROM ipy_module WHERE name = 'leads'`);
  if (!leads) return;
  const policies = [
    { name: 'Hot lead — 15 minute first response', conditions: { logic: 'AND', conditions: [{ field: 'rating', operator: 'equals', value: 'Hot' }] }, first: 15, escalateAfter: 30 },
    { name: 'Standard lead — 2 hour first response', conditions: { logic: 'AND', conditions: [] }, first: 120, escalateAfter: 240 },
  ];
  for (const p of policies) {
    const existing = await conn.queryOne<{ id: string }>(
      `SELECT id FROM ipy_sla_policy WHERE module_id = $1 AND name = $2`, [leads.id, p.name],
    );
    if (existing) continue;
    await conn.query(
      `INSERT INTO ipy_sla_policy (module_id, name, conditions, first_response_minutes, escalate_after_minutes)
       VALUES ($1,$2,$3,$4,$5)`,
      [leads.id, p.name, JSON.stringify(p.conditions), p.first, p.escalateAfter],
    );
  }
}

// ---------------------------------------------------------------------------
// Message templates
// ---------------------------------------------------------------------------

export async function seedTemplates(conn: Tx): Promise<void> {
  // The WhatsApp starter templates that used to be seeded here went with the
  // rest of WhatsApp on 17 September 2026. Email templates below stay.
  const emailTemplates = [
    {
      name: 'booking_welcome',
      subject: 'Welcome home — your booking {{record.booking_number}} is confirmed',
      body: `<p>Dear {{contact.first_name}},</p>
<p>Congratulations on booking <strong>{{record.property_id__display}}</strong> at <strong>{{record.project_name}}</strong>.</p>
<table cellpadding="6" style="border-collapse:collapse">
  <tr><td><strong>Booking ID</strong></td><td>{{record.booking_number}}</td></tr>
  <tr><td><strong>Agreement value</strong></td><td>{{record.agreement_value}}</td></tr>
  <tr><td><strong>Booking date</strong></td><td>{{record.booking_date}}</td></tr>
  <tr><td><strong>Payment plan</strong></td><td>{{record.payment_plan}}</td></tr>
</table>
<p>Your relationship manager {{owner.full_name}} ({{owner.phone}}) will contact you within 24 hours with the documentation checklist.</p>
<p>Warm regards,<br/>{{org.name}}</p>`,
    },
    {
      name: 'property_shortlist_email',
      subject: 'Handpicked properties matching your requirement',
      body: `<p>Hi {{contact.first_name}},</p>
<p>Based on your requirement, here are properties I think you'll like:</p>
{{ai.property_cards}}
<p>Happy to arrange a site visit at your convenience.</p>
<p>{{owner.full_name}}<br/>{{owner.phone}}</p>`,
    },
    {
      name: 'payment_receipt',
      subject: 'Payment receipt — {{record.receipt_number}}',
      body: `<p>Dear {{contact.first_name}},</p>
<p>We have received your payment of <strong>{{record.amount_paid}}</strong> towards {{record.milestone}}.</p>
<p>Receipt number: {{record.receipt_number}}<br/>
Payment mode: {{record.payment_mode}}<br/>
Reference: {{record.reference_number}}</p>
<p>Thank you,<br/>{{org.name}} Accounts Team</p>`,
    },
  ];

  for (const t of emailTemplates) {
    await conn.query(
      `INSERT INTO ipy_email_template (name, subject, body_html, category)
       VALUES ($1,$2,$3,'system')
       ON CONFLICT (name) DO NOTHING`,
      [t.name, t.subject, t.body],
    );
  }
}

/** Default org settings surfaced in the admin panel. */
export async function seedSettings(conn: Tx): Promise<void> {
  const settings: { key: string; value: unknown; category: string; label: string; description?: string }[] = [
    { key: 'org.name', value: 'iPropy Realty', category: 'general', label: 'Organisation Name' },
    { key: 'org.legal_name', value: 'iPropy Realty Private Limited', category: 'general', label: 'Legal Name' },
    { key: 'org.logo_url', value: '', category: 'general', label: 'Logo URL' },
    { key: 'org.primary_color', value: '#6366f1', category: 'branding', label: 'Primary Colour' },
    { key: 'org.currency', value: 'INR', category: 'general', label: 'Default Currency' },
    { key: 'org.timezone', value: 'Asia/Kolkata', category: 'general', label: 'Timezone' },
    { key: 'org.phone', value: '+91 22 4000 0000', category: 'general', label: 'Contact Number' },
    { key: 'org.email', value: 'sales@ipropy.com', category: 'general', label: 'Contact Email' },
    { key: 'org.address', value: { street: 'One Lodha Place', locality: 'Lower Parel', city: 'Mumbai', state: 'Maharashtra', pincode: '400013', country: 'India' }, category: 'general', label: 'Registered Address' },
    { key: 'business_hours', value: { start: '09:30', end: '19:00', days: [1, 2, 3, 4, 5, 6], timezone: 'Asia/Kolkata' }, category: 'general', label: 'Business Hours' },
    { key: 'leads.auto_assign', value: true, category: 'sales', label: 'Auto-assign inbound leads' },
    { key: 'leads.duplicate_window_days', value: 90, category: 'sales', label: 'Duplicate lead window (days)', description: 'A repeat enquiry within this window is merged rather than creating a new lead' },
    { key: 'leads.auto_score', value: true, category: 'ai', label: 'Auto-score new leads with AI' },
    { key: 'inventory.default_hold_days', value: 7, category: 'inventory', label: 'Default unit hold period (days)' },
    { key: 'inventory.allow_overbooking', value: false, category: 'inventory', label: 'Allow booking an already-booked unit' },
    { key: 'ai.call_analysis', value: true, category: 'ai', label: 'Analyse call recordings with AI' },
    { key: 'ai.daily_digest', value: true, category: 'ai', label: 'Send AI daily digest to reps' },
    { key: 'telephony.record_calls', value: true, category: 'telephony', label: 'Record calls' },
  ];

  for (const s of settings) {
    await conn.query(
      `INSERT INTO ipy_setting (key, value, category, label, description)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (key) DO NOTHING`,
      [s.key, JSON.stringify(s.value), s.category, s.label, s.description ?? null],
    );
  }
}

/** Register the integration slots so the admin UI has something to configure. */
export async function seedIntegrations(conn: Tx): Promise<void> {
  const integrations = [
    { provider: 'knowlarity', kind: 'telephony', label: 'Knowlarity' },
    { provider: 'facebook_leads', kind: 'lead_source', label: 'Facebook Lead Ads' },
    { provider: 'google_ads', kind: 'lead_source', label: 'Google Ads Lead Form' },
    { provider: 'zapier', kind: 'lead_source', label: 'Zapier Lead Capture' },
    { provider: 'google_rcs', kind: 'messaging', label: 'Google RCS for Business' },
    /*
      The official WhatsApp Business route, one card per way of buying it.
      Four cards rather than one with a dropdown, because the credentials are
      genuinely different — a Cloud API token and phone number id against a
      reseller's key and campaign name — and because switching provider should
      not mean retyping the one you may go back to. Only one is ever active;
      the registry takes the first switched on.
    */
    { provider: 'whatsapp_meta', kind: 'messaging', label: 'WhatsApp Business — Meta Cloud API' },
    { provider: 'whatsapp_aisensy', kind: 'messaging', label: 'WhatsApp Business — AiSensy' },
    { provider: 'whatsapp_gupshup', kind: 'messaging', label: 'WhatsApp Business — Gupshup' },
    { provider: 'whatsapp_whatsmarketing', kind: 'messaging', label: 'WhatsApp Business — whatsmarketing.in' },
    { provider: 'housing', kind: 'lead_source', label: 'Housing.com' },
    { provider: '99acres', kind: 'lead_source', label: '99acres' },
    { provider: 'magicbricks', kind: 'lead_source', label: 'MagicBricks' },
    { provider: 'nobroker', kind: 'lead_source', label: 'NoBroker' },
    { provider: 'smtp', kind: 'email', label: 'Outbound Email (SMTP)' },
    { provider: 'imap', kind: 'email', label: 'Inbound Email (IMAP)' },
    { provider: 'anthropic', kind: 'ai', label: 'Claude (Anthropic)' },
    // Alternatives to Anthropic, all spoken to over the OpenAI chat-completions
    // shape. Several have a free tier, so the AI features work without a budget.
    { provider: 'ai_gemini', kind: 'ai', label: 'Google Gemini' },
    { provider: 'ai_groq', kind: 'ai', label: 'Groq' },
    { provider: 'ai_openrouter', kind: 'ai', label: 'OpenRouter' },
    { provider: 'ai_openai', kind: 'ai', label: 'OpenAI-compatible' },
    { provider: 'stt', kind: 'ai', label: 'Speech-to-text (Whisper)' },
    { provider: 'sentry', kind: 'ops', label: 'Error reporting (Sentry)' },
    { provider: 's3', kind: 'storage', label: 'S3 Object Storage' },
    { provider: 'onedrive', kind: 'storage', label: 'Microsoft OneDrive' },
  ];
  for (const i of integrations) {
    await conn.query(
      `INSERT INTO ipy_integration (provider, kind, label) VALUES ($1,$2,$3)
       ON CONFLICT (provider, label) DO NOTHING`,
      [i.provider, i.kind, i.label],
    );
  }
}

/**
 * Webform used by the public property website's enquiry forms (a separate
 * app — see the sibling `ipropy-website` checkout). A fixed
 * public_key means the website's server-side proxy (app/api/enquiry/route.ts
 * there) can point at it out of the box with no manual admin-panel setup.
 * Submissions land as real Leads via the existing POST /api/webhooks/forms/:publicKey
 * endpoint — this seed only registers the form, it does not add any new
 * lead-capture code path.
 */
export async function seedWebforms(conn: Tx): Promise<void> {
  const leads = await conn.queryOne<{ id: string }>(`SELECT id FROM ipy_module WHERE name = 'leads'`);
  if (!leads) return;

  await conn.query(
    `INSERT INTO ipy_webform (name, public_key, module_id, fields, defaults, success_message, captcha_enabled, allowed_origins)
     VALUES ($1, $2, $3, $4, $5, $6, false, '[]'::jsonb)
     ON CONFLICT (public_key) DO NOTHING`,
    [
      'Website Enquiry',
      'website-enquiry',
      leads.id,
      JSON.stringify([
        { name: 'first_name', label: 'Full Name', type: 'text', required: true },
        { name: 'mobile', label: 'Phone', type: 'tel', required: true },
        { name: 'email', label: 'Email', type: 'email' },
        { name: 'message', label: 'Message', type: 'textarea' },
        { name: 'project', label: 'Interested Project', type: 'text' },
      ]),
      JSON.stringify({ lead_source: 'Website' }),
      "Thanks — our team will call you shortly.",
    ],
  );
}
