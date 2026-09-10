-- Templates describe a reusable export without binding it to mutable labels or
-- API names. `columns` holds `{ fieldId: "fld_…", header: "…" }` entries.
CREATE TABLE IF NOT EXISTS ipy_export_template (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id   UUID NOT NULL REFERENCES ipy_module(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  columns     JSONB NOT NULL DEFAULT '[]'::jsonb,
  filter      JSONB,
  is_default  BOOLEAN NOT NULL DEFAULT false,
  created_by  UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (module_id, name)
);
CREATE INDEX IF NOT EXISTS idx_export_template_module ON ipy_export_template(module_id, name);
