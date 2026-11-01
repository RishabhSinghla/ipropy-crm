-- Fleet health for the WhatsApp numbers: what went wrong last, when the status last changed, and the watchdog's
-- restart bookkeeping. Columns only, all with safe defaults; nothing is rewritten or deleted.
--
-- ROLLBACK (loses only this bookkeeping, never a message):
--   ALTER TABLE ipy_wa_number
--     DROP COLUMN IF EXISTS last_error, DROP COLUMN IF EXISTS last_error_at,
--     DROP COLUMN IF EXISTS wanted_running, DROP COLUMN IF EXISTS restart_attempts, DROP COLUMN IF EXISTS next_restart_at,
--     DROP COLUMN IF EXISTS last_catchup_at;
ALTER TABLE ipy_wa_number
  ADD COLUMN IF NOT EXISTS last_error        TEXT,
  ADD COLUMN IF NOT EXISTS last_error_at     TIMESTAMPTZ,
  -- false after an admin presses Stop or Unlink, so the watchdog never undoes a deliberate stop
  ADD COLUMN IF NOT EXISTS wanted_running    BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS restart_attempts  INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_restart_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_catchup_at   TIMESTAMPTZ;

-- How many numbers this Render plan can keep connected at once, and its memory. Measured 1 Nov 2026: three live
-- numbers use about 225 MB of the 512 MB plan. Raise both after upgrading the OpenWA server (docs/OPENWA.md).
INSERT INTO ipy_setting (key, value, category, label)
VALUES ('whatsapp.capacity', '{"maxLive":3,"memoryLimitMb":512}'::jsonb, 'whatsapp', 'WhatsApp numbers the OpenWA server can hold')
ON CONFLICT (key) DO NOTHING;
