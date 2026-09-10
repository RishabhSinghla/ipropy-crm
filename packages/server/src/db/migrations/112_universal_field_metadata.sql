-- Universal field metadata foundation. `ipy_field.id` is a database UUID, but
-- integrations need a public permanent ID that cannot be confused with the
-- editable API name.  `internal_id` is that `fld_…` identity.

ALTER TABLE ipy_field ADD COLUMN IF NOT EXISTS internal_id TEXT;

UPDATE ipy_field
   SET internal_id = 'fld_' || replace(id::text, '-', '')
 WHERE internal_id IS NULL;

ALTER TABLE ipy_field ALTER COLUMN internal_id SET NOT NULL;
ALTER TABLE ipy_field ALTER COLUMN internal_id
  SET DEFAULT ('fld_' || replace(gen_random_uuid()::text, '-', ''));
ALTER TABLE ipy_field ADD CONSTRAINT ipy_field_internal_id_unique UNIQUE (internal_id);
ALTER TABLE ipy_field ADD CONSTRAINT ipy_field_internal_id_format
  CHECK (internal_id ~ '^fld_[A-Za-z0-9]{12,64}$');

CREATE OR REPLACE FUNCTION ipy_keep_field_internal_id()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.internal_id <> OLD.internal_id THEN
    RAISE EXCEPTION 'A field internal ID is permanent';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_keep_field_internal_id ON ipy_field;
CREATE TRIGGER trg_keep_field_internal_id
BEFORE UPDATE ON ipy_field
FOR EACH ROW EXECUTE FUNCTION ipy_keep_field_internal_id();

-- API aliases allow external integrations to move to a renamed API name
-- gradually. An alias cannot be reused by a different field in its module.
CREATE TABLE IF NOT EXISTS ipy_field_api_alias (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id         UUID NOT NULL REFERENCES ipy_module(id) ON DELETE CASCADE,
  field_internal_id TEXT NOT NULL,
  api_name          TEXT NOT NULL,
  expires_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (module_id, api_name)
);
CREATE INDEX IF NOT EXISTS idx_field_api_alias_field
  ON ipy_field_api_alias (field_internal_id);

-- Structural audit is separate from record history and survives field deletion.
CREATE TABLE IF NOT EXISTS ipy_field_change (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id         UUID NOT NULL REFERENCES ipy_module(id) ON DELETE CASCADE,
  field_internal_id TEXT NOT NULL,
  action            TEXT NOT NULL CHECK (action IN ('created','updated','renamed','type_changed','deleted','restored','permanently_deleted','mapping_changed')),
  before_value      JSONB,
  after_value       JSONB,
  user_id           UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_field_change_field
  ON ipy_field_change (field_internal_id, created_at DESC);

-- One reusable table for field-to-field mappings between any two modules.
CREATE TABLE IF NOT EXISTS ipy_field_mapping (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_module_id         UUID NOT NULL REFERENCES ipy_module(id) ON DELETE CASCADE,
  target_module_id         UUID NOT NULL REFERENCES ipy_module(id) ON DELETE CASCADE,
  source_field_internal_id TEXT NOT NULL,
  target_field_internal_id TEXT NOT NULL,
  purpose                  TEXT NOT NULL DEFAULT 'matching',
  config                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active                BOOLEAN NOT NULL DEFAULT true,
  created_by               UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_module_id, target_module_id, source_field_internal_id, target_field_internal_id, purpose)
);
CREATE INDEX IF NOT EXISTS idx_field_mapping_lookup
  ON ipy_field_mapping (source_module_id, target_module_id, purpose)
  WHERE is_active;

-- Keep current matching choices while moving their identity to Field IDs.
INSERT INTO ipy_field_mapping (
  source_module_id, target_module_id, source_field_internal_id,
  target_field_internal_id, purpose, config, is_active
)
SELECT sm.id, tm.id, sf.internal_id, tf.internal_id,
       'matching', jsonb_build_object('migratedFrom', 'matching.field_map'), true
  FROM ipy_setting s
  JOIN ipy_module sm ON sm.name = 'leads'
  JOIN ipy_module tm ON tm.name = 'properties'
 CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.value, '[]'::jsonb)) entry
  JOIN ipy_field sf ON sf.module_id = sm.id AND sf.name = entry->>'contactField'
  JOIN ipy_field tf ON tf.module_id = tm.id AND tf.name = entry->>'propertyField'
 WHERE s.key = 'matching.field_map'
ON CONFLICT DO NOTHING;
