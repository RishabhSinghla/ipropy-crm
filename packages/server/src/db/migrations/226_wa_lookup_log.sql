-- The WhatsApp Lookup tool: one row per lookup somebody pressed, so an administrator can see who looked up what,
-- and so the per-user and daily limits are counted from the CRM's own records. `result` is what came back.
-- Additive. To undo: DROP TABLE ipy_wa_lookup_log;
CREATE TABLE IF NOT EXISTS ipy_wa_lookup_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  number      TEXT NOT NULL,               -- digits with country code
  result      TEXT NOT NULL,               -- on_whatsapp | not_on_whatsapp | disconnected | error
  push_name   TEXT,
  from_cache  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_lookup_log_user ON ipy_wa_lookup_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_lookup_log_day ON ipy_wa_lookup_log (created_at) WHERE NOT from_cache;
