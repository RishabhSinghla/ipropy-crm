-- When a WhatsApp number last changed state, and whether admins were already told it is down.
-- status_since: set whenever the status changes. alerted_at: set when the "number is down" alert went out, cleared on recovery,
-- so one outage is one alert (plus a reminder after a day), never one per minute.
-- ROLLBACK: ALTER TABLE ipy_wa_number DROP COLUMN IF EXISTS status_since, DROP COLUMN IF EXISTS alerted_at;
ALTER TABLE ipy_wa_number ADD COLUMN IF NOT EXISTS status_since TIMESTAMPTZ;
ALTER TABLE ipy_wa_number ADD COLUMN IF NOT EXISTS alerted_at TIMESTAMPTZ;
UPDATE ipy_wa_number SET status_since = now() WHERE status_since IS NULL;
