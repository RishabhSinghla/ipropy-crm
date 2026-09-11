-- ===========================================================================
-- iPropy CRM — 128: a list view tab an admin changed stays changed
--
-- Reported as "whatever changes I make to the list view tabs reverts back".
-- It did, and the reason was the seed.
--
-- `upsertViews` matches a seeded tab **by its name** and deletes any system
-- view whose name is no longer in the template. So renaming "Hot Leads" to
-- something this desk actually says deleted the renamed row on the next cold
-- start and re-inserted the original — and `docker-entrypoint.sh` re-seeds on
-- every cold start. Deleting a seeded tab had the same ending by a shorter
-- route: nothing recorded the deletion, so the next seed simply made it again.
--
-- Two columns and one table fix both, and they are the same devices already
-- used for fields (032), blocks (066) and dropdown options (049):
--
--   * `seed_key` remembers which template entry a row came from, so the seed
--     can find it again after a rename. Backfilled from `name`, which is what
--     it has always matched on, so existing installs are unchanged.
--   * `ipy_view_tombstone` records a deliberate deletion, so the seed knows
--     not to recreate it.
--
-- A tab an admin created themselves has no `seed_key` and needs neither: the
-- seed has never known about it.
-- ===========================================================================

ALTER TABLE ipy_view ADD COLUMN IF NOT EXISTS seed_key TEXT;

UPDATE ipy_view SET seed_key = name WHERE is_system = true AND seed_key IS NULL;

-- One seeded tab per module, so a rename cannot collide with a template entry
-- that is still to be inserted.
CREATE UNIQUE INDEX IF NOT EXISTS idx_view_seed_key
  ON ipy_view (module_id, seed_key) WHERE seed_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS ipy_view_tombstone (
  module_id   UUID NOT NULL REFERENCES ipy_module(id) ON DELETE CASCADE,
  seed_key    TEXT NOT NULL,
  deleted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by  UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  PRIMARY KEY (module_id, seed_key)
);
