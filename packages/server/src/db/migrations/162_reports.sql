-- A question somebody asks of the CRM often enough to keep.
--
-- The engine to answer one already exists — `core/analytics/widgets.ts` runs a
-- `WidgetConfig` against any module under the asker's own permissions, which is
-- what a dashboard widget is. What was missing is somewhere to *keep* the
-- question, away from a dashboard's grid: "contacts by source this month",
-- "units by status", "what each agent closed". So a report is a saved
-- WidgetConfig with a name, and nothing else — no second query engine, and no
-- stored numbers.
--
-- Deliberately no stored *answer*. A report holds the question and is run when
-- somebody opens it, as that person: two people opening the same shared report
-- see their own records, exactly as they do in a list. A cached total would be
-- one number for everybody, which is a permissions leak wearing a chart.
CREATE TABLE IF NOT EXISTS ipy_report (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  description  TEXT,
  -- The module's *name*, like every saved view, workflow condition and bookmark
  -- in this CRM: it is the key the rest of the product uses, and it survives a
  -- label change (`leads` is still `leads` while the screen says Contacts).
  module_name  TEXT NOT NULL,
  -- One of the widget types the engine already runs: table, bar, line, pie…
  type         TEXT NOT NULL DEFAULT 'table',
  config       JSONB NOT NULL DEFAULT '{}'::jsonb,
  owner_id     UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  -- Shared with the team, the same decision (and the same capability) as a
  -- shared dashboard.
  is_shared    BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_report_owner ON ipy_report(owner_id);
CREATE INDEX IF NOT EXISTS idx_report_shared ON ipy_report(is_shared) WHERE is_shared;
