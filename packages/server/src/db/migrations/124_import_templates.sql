-- A file that arrives every week should be mapped once.
--
-- The mapping is stored against `ipy_field.internal_id`, never the field name.
-- Names are what an admin renames — "Demand" became "Base Price" on production
-- in August — and a template keyed on a name is a template that silently maps
-- a column to nothing the first time somebody tidies the field list.
--
-- `headers` is the file's signature: the column names, as the exporter writes
-- them. It is what lets the wizard recognise next week's file as the same
-- shape as last week's without anybody choosing a template from a list.
CREATE TABLE IF NOT EXISTS ipy_import_template (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id     uuid NOT NULL REFERENCES ipy_module(id) ON DELETE CASCADE,
  name          text NOT NULL,
  headers       text[] NOT NULL DEFAULT '{}',
  -- header → field internal_id
  mapping       jsonb NOT NULL DEFAULT '{}',
  -- field internal_id → one value for every row in the file
  static_values jsonb NOT NULL DEFAULT '{}',
  -- import mode, duplicate handling, date order, whether to grow dropdowns
  settings      jsonb NOT NULL DEFAULT '{}',
  created_by    uuid REFERENCES ipy_user(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  use_count     integer NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS ipy_import_template_name_uq
  ON ipy_import_template (module_id, lower(name));
CREATE INDEX IF NOT EXISTS ipy_import_template_module_idx
  ON ipy_import_template (module_id);
