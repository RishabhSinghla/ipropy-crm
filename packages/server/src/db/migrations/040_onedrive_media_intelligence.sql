-- OneDrive-backed property folders and non-destructive photo intelligence.
--
-- This migration is deliberately additive. Existing attachment keys and every
-- admin-customised property field continue to work exactly as stored.

INSERT INTO ipy_integration (provider, kind, label, config)
VALUES (
  'onedrive',
  'storage',
  'Microsoft OneDrive',
  '{"rootFolder":"iPropy Properties"}'::jsonb
)
ON CONFLICT (provider, label) DO NOTHING;

-- Empty folders do not exist in object storage. This small retry table lets the
-- scheduler create the complete property folder tree without making the phone
-- wait at the gate, and recreates it automatically if the active storage driver
-- is changed later.
CREATE TABLE IF NOT EXISTS ipy_property_storage (
  record_id            UUID PRIMARY KEY REFERENCES ipy_record(id) ON DELETE CASCADE,
  folder_key           TEXT,
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','running','ready','failed')),
  provisioned_driver   TEXT,
  external_url         TEXT,
  attempts             INT NOT NULL DEFAULT 0,
  last_error           TEXT,
  locked_at            TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_property_storage_pending
  ON ipy_property_storage (status, created_at);

-- Existing production properties join the same pipeline. ON CONFLICT means a
-- re-run can never replace a folder path already chosen for a property.
INSERT INTO ipy_property_storage (record_id)
SELECT id
  FROM ipy_record
 WHERE module_name = 'properties' AND is_deleted = false
ON CONFLICT (record_id) DO NOTHING;

-- Culling is a recommendation, never deletion. A rejected original, its
-- derivatives and its attachment row remain available in Files.
ALTER TABLE ipy_attachment ADD COLUMN IF NOT EXISTS phash TEXT;
ALTER TABLE ipy_attachment ADD COLUMN IF NOT EXISTS stats JSONB;
ALTER TABLE ipy_attachment ADD COLUMN IF NOT EXISTS cull_state TEXT
  CHECK (cull_state IS NULL OR cull_state IN ('keep', 'blurry', 'dark', 'blown', 'duplicate'));
ALTER TABLE ipy_attachment ADD COLUMN IF NOT EXISTS cull_of UUID
  REFERENCES ipy_attachment(id) ON DELETE SET NULL;

-- Vision labels only visible facts. They never become authoritative property
-- fields such as price, address, area, ownership or possession.
ALTER TABLE ipy_attachment ADD COLUMN IF NOT EXISTS ai_category TEXT;
ALTER TABLE ipy_attachment ADD COLUMN IF NOT EXISTS ai_caption TEXT;
ALTER TABLE ipy_attachment ADD COLUMN IF NOT EXISTS ai_confidence NUMERIC(4,3);
ALTER TABLE ipy_attachment ADD COLUMN IF NOT EXISTS ai_classified_at TIMESTAMPTZ;
ALTER TABLE ipy_attachment ADD COLUMN IF NOT EXISTS ai_classification_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE ipy_attachment ADD COLUMN IF NOT EXISTS ai_classification_error TEXT;

CREATE INDEX IF NOT EXISTS idx_attachment_unculled
  ON ipy_attachment (record_id)
  WHERE cull_state IS NULL;

CREATE INDEX IF NOT EXISTS idx_attachment_unclassified
  ON ipy_attachment (record_id)
  WHERE cull_state = 'keep' AND ai_classified_at IS NULL;
