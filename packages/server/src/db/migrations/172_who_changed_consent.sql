-- Who changed somebody's consent, when a person did it by hand.
--
-- A customer's own STOP has no user; a rep pressing "Unsubscribe" or
-- "Subscribe again" does, and "who put them back on the list" is the first
-- question if a complaint ever arrives. Nullable, and kept if the user is
-- removed, so the trail outlives the account.
ALTER TABLE ipy_consent_event
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES ipy_user(id) ON DELETE SET NULL;
