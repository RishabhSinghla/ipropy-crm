-- One row per contact the WhatsApp number checker has looked at: is the number on WhatsApp, and what name it uses.
-- Only the name and a status are kept here (the photo becomes the record's avatar attachment). It is what makes the
-- bulk check resumable: a contact with a row is not asked about again.
-- Additive. To undo: DROP TABLE ipy_wa_lookup;
CREATE TABLE IF NOT EXISTS ipy_wa_lookup (
  record_id   UUID PRIMARY KEY REFERENCES ipy_record(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,              -- on_whatsapp | not_on_whatsapp | failed
  push_name   TEXT,
  photo       TEXT NOT NULL DEFAULT 'none', -- none | saved | skipped
  note        TEXT,
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_lookup_checked ON ipy_wa_lookup (checked_at);
