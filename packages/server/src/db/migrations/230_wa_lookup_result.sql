-- The last WhatsApp Lookup answer for each number, kept so the icon beside a record's Mobile shows it instantly
-- next time. It is the suggestion only: never the contact's own name or photo (those change only when someone
-- presses "Use ..."). Additive. To undo: DROP TABLE ipy_wa_lookup_result;
CREATE TABLE IF NOT EXISTS ipy_wa_lookup_result (
  number       TEXT PRIMARY KEY,            -- digits with country code
  on_whatsapp  BOOLEAN NOT NULL,
  push_name    TEXT,
  photo        BYTEA,
  photo_type   TEXT,
  looked_up_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
