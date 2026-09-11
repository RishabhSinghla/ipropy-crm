-- A saved import is a configuration, not a copy of today's API names.  Each
-- mapped field is stored by immutable `fld_…` identity so an administrator can
-- rename a field without losing a carefully prepared portal/import mapping.
CREATE TABLE IF NOT EXISTS ipy_import_template (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id   UUID NOT NULL REFERENCES ipy_module(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  -- `{ header: { fieldId: "fld_…" } }`; headers remain human-readable because
  -- they describe the incoming file, while fields remain rename-safe.
  mapping     JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Duplicate policy, fixed/default values, source formats, separator and
  -- picklist/unit value maps. Kept together so future file sources can feed
  -- the exact same import pipeline without inventing another template model.
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by  UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (module_id, name)
);

CREATE INDEX IF NOT EXISTS idx_import_template_module
  ON ipy_import_template (module_id, name);
