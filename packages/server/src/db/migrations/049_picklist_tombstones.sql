-- ===========================================================================
-- iPropy CRM — 049: deleting a dropdown option for good
--
-- "Remove" on a dropdown option only ever deactivated it, and the editor then
-- reloaded every option — active or not — as active. So an admin deleted
-- "Lost", saved, refreshed, and there it was again, apparently untouched. The
-- button looked broken because, from where they were standing, it was.
--
-- Two things were wrong and both are fixed:
--
--   1. The editor now reads `is_active` instead of assuming true, so a
--      deactivated option is visibly deactivated.
--   2. An option nothing uses is now *deleted*, not deactivated — and this
--      table is what makes the deletion stick.
--
-- The tombstone is the same device migration 032 introduced for fields, and it
-- is needed for the same reason: `db/seed/picklists.ts` recreates every seeded
-- dropdown on each run, and `docker-entrypoint.sh` re-seeds on every cold
-- start. Without a tombstone the next restart quietly resurrects the option —
-- which, on a free-tier instance that cold-starts several times a day, means
-- the deletion survives about an hour.
--
-- `value = ''` is the sentinel for "the whole dropdown was deleted": a real
-- picklist value is non-empty (the API rejects the empty string), so the empty
-- string cannot collide with one.
--
-- Values an admin created themselves need no tombstone — the seed never
-- creates them — but they get one anyway, so one code path covers both.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS ipy_picklist_tombstone (
  picklist_name  TEXT NOT NULL,
  -- '' = the entire dropdown, not one option
  value          TEXT NOT NULL DEFAULT '',
  deleted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by     UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  -- Kept for the audit trail: how many records held it when it went, and what
  -- they were changed to. Answering "where did that option go?" six months
  -- later is otherwise guesswork.
  had_records    BIGINT,
  replaced_with  TEXT,
  PRIMARY KEY (picklist_name, value)
);

COMMENT ON TABLE ipy_picklist_tombstone IS
  'Dropdowns and dropdown options an administrator deleted permanently. db/seed/picklists.ts skips these so re-seeding cannot resurrect them.';

-- The two dropdowns that existed only for the Campaigns module (048). Recorded
-- here as well as deleted, so an older database that already re-seeded them
-- loses them again rather than keeping an orphan pair nothing renders.
INSERT INTO ipy_picklist_tombstone (picklist_name, value)
VALUES ('campaign_type', ''), ('campaign_status', '')
ON CONFLICT DO NOTHING;

DELETE FROM ipy_picklist WHERE name IN ('campaign_type', 'campaign_status');
