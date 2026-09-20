-- Whether a rep's phone is reachable right now, rather than whether it has
-- ever uploaded a call.
--
-- `last_sync_at` looked like a liveness signal and is not one. The app's
-- background worker runs every fifteen minutes, but it **returns without
-- contacting the CRM at all when there are no new calls** — so a handset that
-- is switched on, signed in and simply having a quiet morning is
-- indistinguishable from one that is off, lost, or has had the app uninstalled.
-- Every question anybody asks about a phone ("is it synced, idle, offline?")
-- needs a signal that exists when nothing is happening.
--
-- Two columns, because they answer two genuinely different questions:
--
--  * `last_seen_at` — the last time *anything* from this phone reached the
--    CRM with its device token. Its resolution is "whenever there was
--    something to say", which is honest but coarse.
--  * `app_open_at` — the last time the **app itself was open** on the phone.
--    This is the one that decides whether pressing Call at a desk can ring it:
--    the instruction travels over the app's own connection, so a closed app
--    cannot be rung however healthy the handset is. Written by the app's own
--    screens, which update themselves, so every phone already in the field
--    starts reporting this without anybody installing anything.
ALTER TABLE ipy_device ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE ipy_device ADD COLUMN IF NOT EXISTS app_open_at  TIMESTAMPTZ;

-- Seeded from what is already known, so a phone that synced this morning does
-- not read as "never heard from" on the day this lands.
UPDATE ipy_device SET last_seen_at = last_sync_at WHERE last_seen_at IS NULL AND last_sync_at IS NOT NULL;
