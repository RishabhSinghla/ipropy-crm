import type { Tx } from '../pool.js';

/**
 * Seeded dashboards. Every widget is a metadata query — module + aggregate +
 * groupBy + filter — so the same widget engine renders anything an admin later
 * builds in the dashboard designer, including on custom modules.
 */

interface WidgetSeed {
  type: string;
  title: string;
  x: number; y: number; w: number; h: number;
  config: Record<string, unknown>;
}

interface DashboardSeed {
  name: string;
  description: string;
  module?: string;
  isDefault?: boolean;
  widgets: WidgetSeed[];
}


export const DASHBOARDS: DashboardSeed[] = [
  {
    name: 'Sales Command Centre',
    description: 'Top-level view of demand, pipeline and revenue.',
    isDefault: true,
    widgets: [
      {
        type: 'metric', title: 'New Leads (This Month)', x: 0, y: 0, w: 3, h: 2,
        config: {
          module: 'leads', aggregate: 'count', format: 'number', comparePrevious: true,
          dateField: 'created_at', color: '#8b5cf6', drilldown: true,
          filter: { logic: 'AND', conditions: [{ field: 'created_at', operator: 'this_month' }] },
        },
      },
      {
        type: 'line', title: 'Lead Volume Trend', x: 0, y: 7, w: 8, h: 4,
        config: {
          module: 'leads', dateField: 'created_at', interval: 'week', aggregate: 'count',
          filter: { logic: 'AND', conditions: [{ field: 'created_at', operator: 'last_n_days', value: 90 }] },
        },
      },
      {
        type: 'donut', title: 'Leads by Source', x: 8, y: 7, w: 4, h: 4,
        config: {
          module: 'leads', groupBy: 'lead_source', aggregate: 'count', drilldown: true,
          filter: { logic: 'AND', conditions: [{ field: 'created_at', operator: 'last_n_days', value: 90 }] },
        },
      },
      {
        type: 'ai_insights', title: 'AI Insights', x: 6, y: 11, w: 6, h: 4,
        config: {
          aiScope: 'sales_overview',
          aiPrompt: 'Analyse this month\'s pipeline health, conversion bottlenecks and revenue risk. Be specific and quantitative.',
        },
      },
    ],
  },

  {
    name: 'My Day',
    description: 'A rep\'s working view: what to call, visit and follow up today.',
    widgets: [
      {
        type: 'metric', title: 'My Open Leads', x: 0, y: 0, w: 3, h: 2,
        config: {
          module: 'leads', aggregate: 'count', color: '#8b5cf6', drilldown: true,
          filter: { logic: 'AND', conditions: [{ field: 'owner_id', operator: 'is_me' }, { field: 'is_converted', operator: 'is_false' }, { field: 'status', operator: 'not_in', value: ['Junk', 'Lost'] }] },
        },
      },
      {
        type: 'metric', title: 'Overdue Follow-ups', x: 3, y: 0, w: 3, h: 2,
        config: {
          module: 'leads', aggregate: 'count', color: '#ef4444', drilldown: true,
          filter: { logic: 'AND', conditions: [{ field: 'owner_id', operator: 'is_me' }, { field: 'next_followup_at', operator: 'older_than_n_days', value: 0 }, { field: 'is_converted', operator: 'is_false' }] },
        },
      },
      {
        // "What is on today" is the leads whose own follow-up date is today —
        // Activities was a second record type holding the same fact.
        type: 'tasks', title: 'Today\'s Follow-ups', x: 0, y: 2, w: 4, h: 6,
        config: {
          module: 'leads', limit: 15, sortBy: 'updated_at', sortDir: 'desc',
          columns: ['full_name', 'mobile', 'status', 'next_followup_at'],
          filter: { logic: 'AND', conditions: [{ field: 'owner_id', operator: 'is_me' }, { field: 'next_followup_at', operator: 'today' }, { field: 'is_converted', operator: 'is_false' }] },
        },
      },
      {
        type: 'list', title: 'Priority Leads to Call', x: 8, y: 2, w: 4, h: 6,
        config: {
          module: 'leads', limit: 10, sortBy: 'updated_at', sortDir: 'desc',
          columns: ['full_name', 'mobile', 'rating', 'budget'],
          filter: { logic: 'AND', conditions: [{ field: 'owner_id', operator: 'is_me' }, { field: 'is_converted', operator: 'is_false' }, { field: 'rating', operator: 'equals', value: 'Hot' }] },
        },
      },
      {
        type: 'ai_insights', title: 'Your Next Best Actions', x: 0, y: 8, w: 12, h: 4,
        config: {
          aiScope: 'my_day',
          aiPrompt: 'Given my open leads, deals and today\'s schedule, list the 5 highest-impact actions I should take today, each with a one-line reason.',
        },
      },
    ],
  },

  {
    name: 'Inventory & Absorption',
    description: 'Live stock position, velocity and pricing across projects.',
    widgets: [
      {
        type: 'metric', title: 'Available Units', x: 0, y: 0, w: 3, h: 2,
        config: {
          module: 'properties', aggregate: 'count', color: '#22c55e', drilldown: true,
          filter: { logic: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'Available' }] },
        },
      },
      {
        type: 'metric', title: 'Blocked / Held', x: 3, y: 0, w: 3, h: 2,
        config: {
          module: 'properties', aggregate: 'count', color: '#f59e0b', drilldown: true,
          filter: { logic: 'AND', conditions: [{ field: 'status', operator: 'in', value: ['Held', 'Blocked'] }] },
        },
      },
      {
        type: 'metric', title: 'Unsold Inventory Value', x: 6, y: 0, w: 3, h: 2,
        config: {
          module: 'properties', aggregate: 'sum', aggregateField: 'total_price', format: 'currency', color: '#3b82f6',
          filter: { logic: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'Available' }] },
        },
      },
      {
        type: 'metric', title: 'Avg Rate / sq.ft', x: 9, y: 0, w: 3, h: 2,
        config: {
          module: 'properties', aggregate: 'avg', aggregateField: 'rate_per_sqft', format: 'currency', color: '#14b8a6',
          filter: { logic: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'Available' }] },
        },
      },
      {
        type: 'inventory_status', title: 'Stock by Project', x: 0, y: 2, w: 7, h: 6,
        config: { module: 'properties', groupBy: 'project_name', stackBy: 'status', limit: 10 },
      },
      {
        type: 'pie', title: 'Availability by Configuration', x: 7, y: 2, w: 5, h: 6,
        config: {
          module: 'properties', groupBy: 'configuration', aggregate: 'count', drilldown: true,
          filter: { logic: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'Available' }] },
        },
      },
      {
        type: 'table', title: 'Blocked Units Expiring Soon', x: 0, y: 8, w: 12, h: 4,
        config: {
          module: 'properties', limit: 15, sortBy: 'blocked_until', sortDir: 'asc',
          columns: ['name', 'project_name', 'configuration', 'total_price', 'blocked_until', 'blocked_for_lead_id'],
          filter: { logic: 'AND', conditions: [{ field: 'status', operator: 'in', value: ['Held', 'Blocked'] }, { field: 'blocked_until', operator: 'next_n_days', value: 7 }] },
        },
      },
    ],
  },

  {
    // Reads the lead's own source and UTM fields, not a campaign record: where
    // an enquiry came from is answered on the enquiry.
    name: 'Marketing Performance',
    description: 'Volume, quality and source mix of the leads coming in.',
    widgets: [
      {
        type: 'metric', title: 'Leads This Month', x: 0, y: 0, w: 4, h: 2,
        config: {
          module: 'leads', aggregate: 'count', color: '#8b5cf6',
          filter: { logic: 'AND', conditions: [{ field: 'created_at', operator: 'this_month' }] },
        },
      },
      {
        type: 'metric', title: 'Qualified Leads', x: 4, y: 0, w: 4, h: 2,
        config: {
          module: 'leads', aggregate: 'count', color: '#22c55e',
          filter: { logic: 'AND', conditions: [{ field: 'created_at', operator: 'this_month' }, { field: 'status', operator: 'in', value: ['Qualified', 'Site Visit Scheduled', 'Site Visit Done', 'Negotiation', 'Converted'] }] },
        },
      },
      {
        type: 'metric', title: 'Avg Lead Score', x: 8, y: 0, w: 4, h: 2,
        config: {
          module: 'leads', aggregate: 'avg', aggregateField: 'budget', format: 'number', color: '#0ea5e9',
          filter: { logic: 'AND', conditions: [{ field: 'created_at', operator: 'this_month' }] },
        },
      },
      {
        type: 'bar', title: 'Leads by Source', x: 0, y: 2, w: 6, h: 5,
        config: {
          module: 'leads', groupBy: 'lead_source', aggregate: 'count', limit: 12,
          filter: { logic: 'AND', conditions: [{ field: 'created_at', operator: 'last_n_days', value: 90 }] },
        },
      },
      {
        type: 'bar', title: 'Lead Quality by Source', x: 6, y: 2, w: 6, h: 5,
        config: {
          module: 'leads', groupBy: 'lead_source', aggregate: 'avg', aggregateField: 'budget', limit: 12,
          filter: { logic: 'AND', conditions: [{ field: 'created_at', operator: 'last_n_days', value: 90 }] },
        },
      },
    ],
  },

];

export async function seedDashboards(conn: Tx): Promise<void> {
  for (const [i, def] of DASHBOARDS.entries()) {
    const existing = await conn.queryOne<{ id: string }>(
      `SELECT id FROM ipy_dashboard WHERE name = $1 AND is_system = true`,
      [def.name],
    );
    // Create-only. This used to DELETE every widget on the dashboard and put
    // the seeded set back, which meant each widget an admin added, moved or
    // resized was destroyed — not merely on deploy, but on every cold start,
    // because docker-entrypoint.sh re-seeds when the instance wakes up. A
    // dashboard that already exists belongs to whoever has been editing it.
    if (existing) continue;

    const moduleId = def.module
      ? (await conn.queryOne<{ id: string }>(`SELECT id FROM ipy_module WHERE name = $1`, [def.module]))?.id ?? null
      : null;
    const row = await conn.queryOne<{ id: string }>(
      `INSERT INTO ipy_dashboard (name, description, is_shared, is_default, is_system, module_id, sequence)
       VALUES ($1,$2,true,$3,true,$4,$5) RETURNING id`,
      [def.name, def.description, def.isDefault ?? false, moduleId, i],
    );
    const dashboardId = row!.id;

    for (const [j, w] of def.widgets.entries()) {
      await conn.query(
        `INSERT INTO ipy_dashboard_widget (dashboard_id, type, title, x, y, w, h, config, sequence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [dashboardId, w.type, w.title, w.x, w.y, w.w, w.h, JSON.stringify(w.config), j],
      );
    }
  }
}
