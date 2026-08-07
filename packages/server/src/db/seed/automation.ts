import type { Tx } from '../pool.js';

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
  {
    module: 'leads',
    name: 'Instant lead response',
    description: 'Greets a new lead on WhatsApp within seconds and tells the rep to call. Speed-to-lead is the single biggest conversion lever.',
    trigger: 'on_create',
    executionMode: 'once',
    tasks: [
      {
        type: 'ai_action', name: 'Score and grade the lead',
        config: { action: 'score_lead', writeTo: { score: 'ai_score', grade: 'ai_grade', reasons: 'ai_score_reasons' } },
      },
      {
        type: 'send_whatsapp', name: 'Send welcome message',
        config: {
          to: '{{mobile}}',
          template: 'lead_welcome',
          fallbackText: 'Hi {{first_name}}, thanks for your interest in {{interested_project_id__display}}. I am {{owner_name}} from iPropy. When would be a good time to call you?',
          skipIf: { logic: 'AND', conditions: [{ field: 'mobile', operator: 'is_empty' }] },
        },
      },
      {
        type: 'create_task', name: 'Create first-call task',
        config: {
          subject: 'Call new lead: {{first_name}} {{last_name}}',
          activity_type: 'Call',
          priority: 'High',
          dueInMinutes: 30,
          assignTo: 'record_owner',
        },
      },
      {
        type: 'notify_user', name: 'Ping the owner',
        config: { to: 'record_owner', title: 'New lead assigned', body: '{{first_name}} {{last_name}} — {{lead_source}} — {{mobile}}' },
      },
    ],
  },
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
      { type: 'notify_user', name: 'Notify reporting manager', config: { to: 'owner_manager', title: 'Lead not contacted', body: '{{first_name}} {{last_name}} has been sitting untouched for over 2 hours.' } },
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
        config: { action: 'draft_message', channel: 'whatsapp', tone: 'warm', goal: 'revive interest with a relevant new inventory or price update' },
      },
      { type: 'send_whatsapp', name: 'Send nurture message', config: { to: '{{mobile}}', useAiDraft: true, template: 'lead_nurture' } },
    ],
  },
  {
    module: 'leads',
    name: 'Re-score on engagement',
    description: 'Recomputes the AI score whenever the lead\'s status or requirement changes.',
    trigger: 'on_field_change',
    watchFields: ['status', 'budget_max', 'possession_timeline', 'interested_project_id', 'funding_type'],
    tasks: [{ type: 'ai_action', name: 'Re-score', config: { action: 'score_lead', writeTo: { score: 'ai_score', grade: 'ai_grade', reasons: 'ai_score_reasons' } } }],
  },

  // --- Site visits -----------------------------------------------------------
  {
    module: 'site_visits',
    name: 'Site visit confirmation',
    description: 'Sends the client a confirmation with location and pickup details as soon as a visit is scheduled.',
    trigger: 'on_create',
    tasks: [
      { type: 'send_whatsapp', name: 'Send confirmation', config: { to: 'related_contact_mobile', template: 'site_visit_confirmation' } },
      { type: 'update_fields', name: 'Mark confirmation sent', config: { values: { confirmation_sent: true } } },
    ],
  },
  {
    module: 'site_visits',
    name: 'Site visit reminder (T-2h)',
    description: 'Reminds the client and the rep two hours before the visit.',
    trigger: 'on_create',
    conditions: { logic: 'AND', conditions: [{ field: 'status', operator: 'in', value: ['Scheduled', 'Confirmed'] }] },
    tasks: [
      {
        type: 'send_whatsapp', name: 'Client reminder',
        delayField: 'scheduled_at', delayDirection: 'before', delayMinutes: 120,
        config: { to: 'related_contact_mobile', template: 'site_visit_reminder' },
      },
      {
        type: 'notify_user', name: 'Rep reminder',
        delayField: 'scheduled_at', delayDirection: 'before', delayMinutes: 120,
        config: { to: 'record_owner', title: 'Site visit in 2 hours', body: '{{subject}} at {{scheduled_at}}' },
      },
    ],
  },
  {
    module: 'site_visits',
    name: 'Post-visit follow-up',
    description: 'Captures feedback and drafts the next step after a completed visit.',
    trigger: 'on_field_change',
    watchFields: ['status'],
    conditions: { logic: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'Completed' }] },
    tasks: [
      { type: 'ai_action', name: 'Summarise the visit', delayMinutes: 30, config: { action: 'summarise_visit', writeTo: { summary: 'ai_summary', sentiment: 'ai_sentiment' } } },
      { type: 'send_whatsapp', name: 'Thank-you + feedback ask', delayMinutes: 120, config: { to: 'related_contact_mobile', template: 'site_visit_thankyou' } },
      { type: 'create_task', name: 'Follow-up call', delayMinutes: 0, config: { subject: 'Post-visit follow-up: {{subject}}', activity_type: 'Follow Up', priority: 'High', dueInMinutes: 1440, assignTo: 'record_owner' } },
      {
        type: 'update_fields', name: 'Promote to Prospect',
        config: { targetRecord: 'lead_id', targetModule: 'leads', advanceLifecycle: 'Prospect' },
      },
    ],
  },

  // --- Deals -----------------------------------------------------------------
  {
    module: 'deals',
    name: 'Sync stage probability',
    description: 'Keeps probability, win/loss flags and stage timers in step with the stage picklist.',
    trigger: 'on_field_change',
    watchFields: ['stage'],
    tasks: [{ type: 'update_fields', name: 'Apply stage metadata', config: { applyStageMeta: true } }],
  },
  {
    module: 'deals',
    name: 'Analyse deal risk nightly',
    description: 'Scores open deals for stall risk and writes a recommended next action.',
    trigger: 'scheduled',
    schedule: { frequency: 'daily', time: '02:00' },
    conditions: { logic: 'AND', conditions: [{ field: 'is_won', operator: 'is_false' }, { field: 'is_lost', operator: 'is_false' }] },
    tasks: [{ type: 'ai_action', name: 'Risk analysis', config: { action: 'analyse_deal', writeTo: { score: 'ai_risk_score', reasons: 'ai_risk_reasons', nextAction: 'ai_next_action', forecast: 'ai_forecast_close' } } }],
  },
  {
    module: 'deals',
    name: 'Stalled deal alert',
    description: 'Flags deals that have not moved stage in 14 days.',
    trigger: 'scheduled',
    schedule: { frequency: 'daily', time: '09:00' },
    conditions: {
      logic: 'AND',
      conditions: [
        { field: 'is_won', operator: 'is_false' },
        { field: 'is_lost', operator: 'is_false' },
        { field: 'stage_changed_at', operator: 'older_than_n_days', value: 14 },
      ],
    },
    tasks: [
      { type: 'notify_user', name: 'Alert owner', config: { to: 'record_owner', title: 'Deal is stalling', body: '{{name}} has been in {{stage}} for over 14 days.' } },
      { type: 'create_task', name: 'Revive task', config: { subject: 'Revive stalled deal: {{name}}', activity_type: 'Follow Up', priority: 'High', dueInMinutes: 480, assignTo: 'record_owner' } },
    ],
  },
  {
    module: 'deals',
    name: 'Hold unit on token',
    description: 'Blocks the linked unit for 7 days when a token is received.',
    trigger: 'on_field_change',
    watchFields: ['stage'],
    conditions: { logic: 'AND', conditions: [{ field: 'stage', operator: 'equals', value: 'Token Received' }, { field: 'property_id', operator: 'is_not_empty' }] },
    tasks: [{ type: 'update_fields', name: 'Block the unit', config: { targetRecord: 'property_id', targetModule: 'properties', values: { status: 'Blocked' }, setBlockedUntilDays: 7 } }],
  },

  // --- Bookings & payments ---------------------------------------------------
  {
    module: 'bookings',
    name: 'Booking confirmation pack',
    description: 'Congratulates the customer, marks the unit sold and starts the documentation checklist.',
    trigger: 'on_create',
    tasks: [
      { type: 'update_fields', name: 'Mark unit booked', config: { targetRecord: 'property_id', targetModule: 'properties', values: { status: 'Booked' } } },
      {
        type: 'update_fields', name: 'Promote buyer to Customer',
        config: { targetRecord: 'contact_id', targetModule: 'leads', advanceLifecycle: 'Customer' },
      },
      { type: 'send_whatsapp', name: 'Congratulate the customer', config: { to: 'related_contact_mobile', template: 'booking_confirmation' } },
      { type: 'send_email', name: 'Email the cost sheet', config: { to: 'related_contact_email', template: 'booking_welcome' } },
      { type: 'create_record', name: 'Generate payment schedule', config: { action: 'generate_payment_schedule' } },
      { type: 'create_task', name: 'Collect KYC', config: { subject: 'Collect KYC for {{booking_number}}', activity_type: 'Documentation', priority: 'High', dueInMinutes: 2880, assignTo: 'record_owner' } },
    ],
  },
  {
    module: 'payments',
    name: 'Payment due reminder',
    description: 'Reminds the customer 3 days before an instalment falls due.',
    trigger: 'scheduled',
    schedule: { frequency: 'daily', time: '10:00' },
    conditions: {
      logic: 'AND',
      conditions: [
        { field: 'due_date', operator: 'next_n_days', value: 3 },
        { field: 'status', operator: 'not_in', value: ['Paid', 'Waived'] },
      ],
    },
    tasks: [
      { type: 'send_whatsapp', name: 'Due reminder', config: { to: 'related_contact_mobile', template: 'payment_reminder' } },
      { type: 'update_fields', name: 'Track reminder', config: { incrementFields: { reminder_count: 1 }, values: { last_reminder_at: '{{now}}' } } },
    ],
  },
  {
    module: 'payments',
    name: 'Overdue payment escalation',
    description: 'Escalates to collections once an instalment is 7 days late.',
    trigger: 'scheduled',
    schedule: { frequency: 'daily', time: '11:00' },
    conditions: {
      logic: 'AND',
      conditions: [
        { field: 'due_date', operator: 'older_than_n_days', value: 7 },
        { field: 'status', operator: 'not_in', value: ['Paid', 'Waived'] },
      ],
    },
    tasks: [
      { type: 'update_fields', name: 'Mark overdue', config: { values: { status: 'Overdue' } } },
      { type: 'send_whatsapp', name: 'Overdue notice', config: { to: 'related_contact_mobile', template: 'payment_overdue' } },
      { type: 'notify_user', name: 'Alert collections', config: { to: 'group:Post-Sales & Collections', title: 'Overdue instalment', body: '{{payment_number}} — {{amount_due}} due since {{due_date}}' } },
    ],
  },

  // --- Inventory -------------------------------------------------------------
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

  // --- Contacts --------------------------------------------------------------
  {
    module: 'leads',
    name: 'Birthday greeting',
    description: 'Sends a WhatsApp greeting on a customer\'s birthday.',
    trigger: 'scheduled',
    schedule: { frequency: 'daily', time: '09:00' },
    conditions: { logic: 'AND', conditions: [{ field: 'date_of_birth', operator: 'today' }, { field: 'do_not_whatsapp', operator: 'is_false' }] },
    tasks: [{ type: 'send_whatsapp', name: 'Birthday wish', config: { to: '{{mobile}}', template: 'birthday_greeting' } }],
  },
];

export async function seedWorkflows(conn: Tx): Promise<void> {
  for (const [i, wf] of WORKFLOWS.entries()) {
    const mod = await conn.queryOne<{ id: string }>(`SELECT id FROM ipy_module WHERE name = $1`, [wf.module]);
    if (!mod) continue;

    const existing = await conn.queryOne<{ id: string }>(
      `SELECT id FROM ipy_workflow WHERE module_id = $1 AND name = $2`,
      [mod.id, wf.name],
    );

    let workflowId: string;
    const params = [
      mod.id, wf.name, wf.description, wf.trigger,
      JSON.stringify(wf.watchFields ?? []),
      JSON.stringify(wf.conditions ?? { logic: 'AND', conditions: [] }),
      wf.executionMode ?? 'always',
      wf.schedule ? JSON.stringify(wf.schedule) : null,
      wf.active !== false, i,
    ];

    if (existing) {
      workflowId = existing.id;
      // module_id/name (params[0],[1]) aren't updated, so bind only what's used —
      // otherwise Postgres can't infer the types of the two unreferenced params.
      await conn.query(
        `UPDATE ipy_workflow SET description = $1, trigger = $2, watch_fields = $3,
           conditions = $4, execution_mode = $5, schedule = $6, is_active = $7,
           sequence = $8, updated_at = now()
         WHERE id = $9`,
        [...params.slice(2), workflowId],
      );
      await conn.query(`DELETE FROM ipy_workflow_task WHERE workflow_id = $1`, [workflowId]);
    } else {
      const row = await conn.queryOne<{ id: string }>(
        `INSERT INTO ipy_workflow
          (module_id, name, description, trigger, watch_fields, conditions,
           execution_mode, schedule, is_active, sequence, is_system)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)
         RETURNING id`,
        params,
      );
      workflowId = row!.id;
    }

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

  const insideSales = await conn.queryOne<{ id: string }>(`SELECT id FROM ipy_group WHERE name = 'Inside Sales'`);
  const fieldSales = await conn.queryOne<{ id: string }>(`SELECT id FROM ipy_group WHERE name = 'Field Sales — West'`);

  const rules = [
    {
      name: 'High-value leads to field sales',
      conditions: { logic: 'AND', conditions: [{ field: 'budget_max', operator: 'greater_or_equal', value: 15000000 }] },
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
    if (existing) {
      await conn.query(
        `UPDATE ipy_assignment_rule SET conditions = $2, strategy = $3, target_group_id = $4, sequence = $5 WHERE id = $1`,
        [existing.id, JSON.stringify(r.conditions), r.strategy, r.groupId, r.sequence],
      );
    } else {
      await conn.query(
        `INSERT INTO ipy_assignment_rule (module_id, name, conditions, strategy, target_group_id, sequence)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [leads.id, r.name, JSON.stringify(r.conditions), r.strategy, r.groupId, r.sequence],
      );
    }
  }
}

// ---------------------------------------------------------------------------
// SLA policies
// ---------------------------------------------------------------------------

export async function seedSlaPolicies(conn: Tx): Promise<void> {
  const leads = await conn.queryOne<{ id: string }>(`SELECT id FROM ipy_module WHERE name = 'leads'`);
  if (!leads) return;
  const policies = [
    { name: 'Hot lead — 15 minute first response', conditions: { logic: 'AND', conditions: [{ field: 'ai_score', operator: 'greater_or_equal', value: 70 }] }, first: 15, escalateAfter: 30 },
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

interface TemplateSeed {
  name: string;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  header?: string;
  body: string;
  footer?: string;
  buttons?: { type: string; text: string; url?: string }[];
  variables: Record<string, string>;
}

const WHATSAPP_TEMPLATES: TemplateSeed[] = [
  {
    name: 'lead_welcome', category: 'UTILITY',
    header: 'Thanks for your interest!',
    body: 'Hi {{1}}, thank you for enquiring about {{2}}. I\'m {{3}} from {{4}} and I\'ll be helping you find the right home.\n\nCould you share a good time to call you today?',
    footer: 'Reply STOP to opt out',
    buttons: [{ type: 'QUICK_REPLY', text: 'Call me now' }, { type: 'QUICK_REPLY', text: 'Send details' }],
    variables: { '1': 'record.first_name', '2': 'record.interested_project_id__display', '3': 'owner.first_name', '4': 'org.name' },
  },
  {
    name: 'lead_nurture', category: 'MARKETING',
    body: 'Hi {{1}}, just checking in on your home search. We have new inventory in {{2}} that fits your budget of {{3}}.\n\nWould you like to see the latest options?',
    footer: 'Reply STOP to opt out',
    buttons: [{ type: 'QUICK_REPLY', text: 'Yes, share options' }, { type: 'QUICK_REPLY', text: 'Not right now' }],
    variables: { '1': 'record.first_name', '2': 'record.preferred_locations', '3': 'record.budget_max' },
  },
  {
    name: 'site_visit_confirmation', category: 'UTILITY',
    header: 'Site visit confirmed',
    body: 'Hi {{1}}, your site visit to {{2}} is confirmed for {{3}}.\n\nAddress: {{4}}\nYour host: {{5}} ({{6}})\n\nSee you there!',
    buttons: [{ type: 'URL', text: 'Get directions', url: 'https://maps.google.com/?q={{1}}' }],
    variables: { '1': 'contact.first_name', '2': 'record.project_id__display', '3': 'record.scheduled_at', '4': 'project.address', '5': 'owner.full_name', '6': 'owner.phone' },
  },
  {
    name: 'site_visit_reminder', category: 'UTILITY',
    body: 'Reminder: your visit to {{1}} is in 2 hours, at {{2}}. {{3}} will meet you at the site office.\n\nNeed to reschedule?',
    buttons: [{ type: 'QUICK_REPLY', text: 'On my way' }, { type: 'QUICK_REPLY', text: 'Reschedule' }],
    variables: { '1': 'record.project_id__display', '2': 'record.scheduled_at', '3': 'owner.first_name' },
  },
  {
    name: 'site_visit_thankyou', category: 'UTILITY',
    body: 'Hi {{1}}, thank you for visiting {{2}} today. I hope you liked what you saw.\n\nHow would you rate the property?',
    buttons: [
      { type: 'QUICK_REPLY', text: 'Loved it' },
      { type: 'QUICK_REPLY', text: 'Need to think' },
      { type: 'QUICK_REPLY', text: 'Not for me' },
    ],
    variables: { '1': 'contact.first_name', '2': 'record.project_id__display' },
  },
  {
    name: 'booking_confirmation', category: 'UTILITY',
    header: 'Congratulations on your new home!',
    body: 'Dear {{1}}, your booking for {{2}} at {{3}} is confirmed.\n\nBooking ID: {{4}}\nAgreement value: {{5}}\n\nOur CRM team will reach out with the documentation checklist shortly.',
    variables: { '1': 'contact.first_name', '2': 'record.property_id__display', '3': 'record.project_id__display', '4': 'record.booking_number', '5': 'record.agreement_value' },
  },
  {
    name: 'payment_reminder', category: 'UTILITY',
    body: 'Dear {{1}}, a payment of {{2}} for {{3}} is due on {{4}}.\n\nPlease ignore if already paid.',
    buttons: [{ type: 'QUICK_REPLY', text: 'Already paid' }, { type: 'QUICK_REPLY', text: 'Need help' }],
    variables: { '1': 'contact.first_name', '2': 'record.amount_due', '3': 'record.milestone', '4': 'record.due_date' },
  },
  {
    name: 'payment_overdue', category: 'UTILITY',
    body: 'Dear {{1}}, our records show {{2}} for {{3}} is overdue since {{4}}. Kindly arrange payment at the earliest to avoid late charges.\n\nContact {{5}} for assistance.',
    variables: { '1': 'contact.first_name', '2': 'record.amount_due', '3': 'record.milestone', '4': 'record.due_date', '5': 'owner.phone' },
  },
  {
    name: 'birthday_greeting', category: 'MARKETING',
    body: 'Happy birthday, {{1}}! 🎉\n\nWishing you a wonderful year ahead from all of us at {{2}}.',
    variables: { '1': 'record.first_name', '2': 'org.name' },
  },
  {
    name: 'property_shortlist', category: 'MARKETING',
    header: 'Handpicked for you',
    body: 'Hi {{1}}, based on your requirement ({{2}}, {{3}}) I\'ve shortlisted {{4}} options for you.\n\nShall I send the details?',
    buttons: [{ type: 'QUICK_REPLY', text: 'Yes please' }, { type: 'QUICK_REPLY', text: 'Call me' }],
    variables: { '1': 'record.first_name', '2': 'record.configuration', '3': 'record.budget_max', '4': 'ai.match_count' },
  },
];

export async function seedTemplates(conn: Tx): Promise<void> {
  for (const t of WHATSAPP_TEMPLATES) {
    await conn.query(
      `INSERT INTO ipy_whatsapp_template
        (name, language, category, status, header_text, header_format, body_text, footer_text, buttons, variable_map)
       VALUES ($1,'en',$2,'LOCAL',$3,$4,$5,$6,$7,$8)
       ON CONFLICT (name, language) DO UPDATE SET
         category = EXCLUDED.category, header_text = EXCLUDED.header_text,
         body_text = EXCLUDED.body_text, footer_text = EXCLUDED.footer_text,
         buttons = EXCLUDED.buttons, variable_map = EXCLUDED.variable_map`,
      [
        t.name, t.category, t.header ?? null, t.header ? 'TEXT' : null,
        t.body, t.footer ?? null,
        JSON.stringify(t.buttons ?? []), JSON.stringify(t.variables),
      ],
    );
  }

  const emailTemplates = [
    {
      name: 'booking_welcome',
      subject: 'Welcome home — your booking {{record.booking_number}} is confirmed',
      body: `<p>Dear {{contact.first_name}},</p>
<p>Congratulations on booking <strong>{{record.property_id__display}}</strong> at <strong>{{record.project_id__display}}</strong>.</p>
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
       ON CONFLICT (name) DO UPDATE SET subject = EXCLUDED.subject, body_html = EXCLUDED.body_html`,
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
    { key: 'ai.auto_reply_whatsapp', value: false, category: 'ai', label: 'Let AI auto-reply on WhatsApp', description: 'When off, AI drafts a reply for the rep to approve' },
    { key: 'ai.call_analysis', value: true, category: 'ai', label: 'Analyse call recordings with AI' },
    { key: 'ai.daily_digest', value: true, category: 'ai', label: 'Send AI daily digest to reps' },
    { key: 'telephony.record_calls', value: true, category: 'telephony', label: 'Record calls' },
    { key: 'telephony.mask_numbers', value: true, category: 'telephony', label: 'Mask customer numbers from agents' },
    { key: 'whatsapp.session_window_hours', value: 24, category: 'whatsapp', label: 'Customer service window (hours)' },
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
    { provider: 'meta_whatsapp', kind: 'messaging', label: 'WhatsApp Business (Meta Cloud API)' },
    { provider: 'twilio', kind: 'telephony', label: 'Twilio Voice' },
    { provider: 'exotel', kind: 'telephony', label: 'Exotel' },
    { provider: 'knowlarity', kind: 'telephony', label: 'Knowlarity' },
    { provider: 'facebook_leads', kind: 'lead_source', label: 'Facebook Lead Ads' },
    { provider: 'google_ads', kind: 'lead_source', label: 'Google Ads Lead Form' },
    { provider: 'housing', kind: 'lead_source', label: 'Housing.com' },
    { provider: '99acres', kind: 'lead_source', label: '99acres' },
    { provider: 'magicbricks', kind: 'lead_source', label: 'MagicBricks' },
    { provider: 'nobroker', kind: 'lead_source', label: 'NoBroker' },
    { provider: 'smtp', kind: 'email', label: 'Outbound Email (SMTP)' },
    { provider: 'imap', kind: 'email', label: 'Inbound Email (IMAP)' },
    { provider: 'anthropic', kind: 'ai', label: 'Claude (Anthropic)' },
    { provider: 'stt', kind: 'ai', label: 'Speech-to-text (Whisper)' },
    { provider: 's3', kind: 'storage', label: 'S3 Object Storage' },
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
 * app — see /Users/rishabhsinghla/Downloads/ipropy-website). A fixed
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
     ON CONFLICT (public_key) DO UPDATE SET
       module_id = EXCLUDED.module_id, fields = EXCLUDED.fields, defaults = EXCLUDED.defaults,
       success_message = EXCLUDED.success_message`,
    [
      'Website Enquiry',
      'website-enquiry',
      leads.id,
      JSON.stringify([
        { name: 'first_name', label: 'Full Name' },
        { name: 'mobile', label: 'Phone' },
        { name: 'email', label: 'Email' },
        { name: 'message', label: 'Message' },
        { name: 'project', label: 'Interested Project' },
      ]),
      JSON.stringify({ lead_source: 'Website' }),
      "Thanks — our team will call you shortly.",
    ],
  );
}
