-- Finish has to survive the CRM not being able to reach n8n.
--
-- Pressing Finish posts to n8n's webhook, which works only while both sit on
-- one laptop. In production the CRM is on Render and n8n is behind a home
-- router, so the post can never arrive and the rep is told their upload is
-- being processed when nothing is listening.
--
-- So Finish records the request instead, and n8n collects it on its own timer.
-- The webhook still fires when it can — that keeps it instant locally — but the
-- row is what makes it reliable.
ALTER TABLE ipy_property_storage
  ADD COLUMN IF NOT EXISTS media_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS media_done_at      TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_property_storage_media_wanted
  ON ipy_property_storage (media_requested_at)
  WHERE media_requested_at IS NOT NULL;
