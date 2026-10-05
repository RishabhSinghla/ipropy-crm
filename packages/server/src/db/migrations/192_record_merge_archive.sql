-- A merge must keep its original values and relationship ownership, not just
-- a sentence saying that something disappeared. No existing rows are changed.
CREATE TABLE IF NOT EXISTS ipy_record_merge_archive (
  batch_key TEXT PRIMARY KEY,
  survivor_id UUID,
  actor_id UUID NOT NULL REFERENCES ipy_user(id),
  snapshot JSONB NOT NULL,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
