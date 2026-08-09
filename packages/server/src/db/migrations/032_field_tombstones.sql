-- ===========================================================================
-- iPropy CRM — 032: deleting a built-in field for good
--
-- "Remove" on a seeded field only ever deactivated it, because a true delete
-- could not stick: `npm run db:seed` rewrites every module from
-- db/seed/modules.ts, so the row would reappear on the next run and the admin
-- would reasonably conclude the button was broken.
--
-- A tombstone is what makes the delete durable. The seed consults this table
-- and skips anything named in it, so a field an administrator deleted stays
-- deleted across re-seeds, upgrades and redeploys.
--
-- Custom fields need no tombstone — the seed never creates them.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS ipy_field_tombstone (
  module_name  TEXT NOT NULL,
  field_name   TEXT NOT NULL,
  deleted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by   UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  -- Kept for the audit trail: which column was dropped, and whether it held
  -- real data at the time. Answering "what happened to that field?" six months
  -- later is otherwise guesswork.
  storage      TEXT,
  column_name  TEXT,
  had_values   BIGINT,
  PRIMARY KEY (module_name, field_name)
);

COMMENT ON TABLE ipy_field_tombstone IS
  'Seeded fields an administrator deleted permanently. db/seed/helpers.ts skips these so re-seeding cannot resurrect them.';
