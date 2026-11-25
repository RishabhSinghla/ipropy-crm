-- The name/photo checker now spreads its work over every connected WhatsApp number (round robin), with a daily cap
-- per number. This remembers which number asked, so each number's cap is counted from the CRM's own rows.
-- Additive. To undo: ALTER TABLE ipy_wa_lookup DROP COLUMN number_id;
ALTER TABLE ipy_wa_lookup ADD COLUMN IF NOT EXISTS number_id UUID REFERENCES ipy_wa_number(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_wa_lookup_number_day ON ipy_wa_lookup (number_id, checked_at);
