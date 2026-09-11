-- Idempotency and full-fidelity backup for the Vtiger migration.
--
-- One row per migrated ipy_record. Lets the migration command be re-run
-- safely — Vtiger-cloud's rate limiting means a full pull can be
-- interrupted, and re-running must skip anything already loaded rather than
-- create a duplicate lead. `raw` keeps the complete original Vtiger row,
-- including every field this migration didn't map onto anything — nothing
-- is ever unrecoverable just because it wasn't given a dedicated field.
CREATE TABLE IF NOT EXISTS ipy_record_external_ref (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id     UUID NOT NULL REFERENCES ipy_record(id) ON DELETE CASCADE,
  source        TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  raw           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_record_external_ref_record ON ipy_record_external_ref(record_id);

-- Same idempotency need for timeline entries that aren't ipy_record rows —
-- the same convention ipy_attachment already uses for OneDrive ingestion
-- (migration 041's source_external_id).
ALTER TABLE ipy_comment ADD COLUMN IF NOT EXISTS source_external_id TEXT UNIQUE;
ALTER TABLE ipy_call ADD COLUMN IF NOT EXISTS source_external_id TEXT UNIQUE;
ALTER TABLE ipy_email_log ADD COLUMN IF NOT EXISTS source_external_id TEXT UNIQUE;
