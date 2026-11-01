-- One WhatsApp number (an OpenWA session) per agent.
-- Each row is a session on the OpenWA server; user_id says which agent works from it; one row may be the company default.
-- Every message also remembers which number carried it (ipy_message.number_id), so history is never re-attributed.
-- Nothing is deleted or rewritten: existing OpenWA messages are only TAGGED with the current company session.
--
-- ROLLBACK (safe at any time, loses no messages):
--   ALTER TABLE ipy_message DROP COLUMN IF EXISTS number_id;
--   DROP TABLE IF EXISTS ipy_wa_number;
CREATE TABLE IF NOT EXISTS ipy_wa_number (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_name    TEXT NOT NULL UNIQUE,
  session_id      TEXT,
  label           TEXT,
  phone           TEXT,
  user_id         UUID UNIQUE REFERENCES ipy_user(id) ON DELETE SET NULL,
  is_default      BOOLEAN NOT NULL DEFAULT false,
  paused          BOOLEAN NOT NULL DEFAULT false,
  paused_at       TIMESTAMPTZ,
  paused_by       UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'unknown',
  last_active_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_number_one_default ON ipy_wa_number (is_default) WHERE is_default;

ALTER TABLE ipy_message ADD COLUMN IF NOT EXISTS number_id UUID REFERENCES ipy_wa_number(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_message_number ON ipy_message (number_id, created_at) WHERE number_id IS NOT NULL;

-- The company session already configured on the OpenWA card becomes the default number.
-- No-op on a fresh database (the card does not exist yet).
INSERT INTO ipy_wa_number (session_name, label, is_default)
  SELECT btrim(config->>'sessionName'), 'Company number', true
    FROM ipy_integration
   WHERE provider = 'whatsapp_openwa' AND btrim(coalesce(config->>'sessionName', '')) <> ''
   LIMIT 1
ON CONFLICT (session_name) DO NOTHING;

-- Tag the history it carried (only rows with no number yet; safe to run twice).
UPDATE ipy_message SET number_id = (SELECT id FROM ipy_wa_number WHERE is_default LIMIT 1)
 WHERE provider = 'whatsapp_openwa' AND number_id IS NULL
   AND EXISTS (SELECT 1 FROM ipy_wa_number WHERE is_default);
