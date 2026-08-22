-- A section an administrator deleted or renamed stays that way.
--
-- Sections were the one part of the data model the seed still owned outright:
-- it upserts every block on every cold start, label included, so a section
-- deleted in the admin panel came back a few hours later and a renamed one
-- reverted to the name in the template. There was no way to tell — the panel
-- said it had worked, and it had, until the container restarted.
--
-- Same two mechanisms the rest of the model already uses: a tombstone makes a
-- deletion durable (ipy_field_tombstone, 032; ipy_picklist_tombstone, 049), and
-- `is_customised` marks a row as the admin's, which the seed then leaves alone
-- (ipy_layout.is_customised; ipy_field.is_customised).

CREATE TABLE IF NOT EXISTS ipy_block_tombstone (
  module_name  TEXT NOT NULL,
  block_name   TEXT NOT NULL,
  deleted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by   UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  -- Kept for the audit trail: what it was called when it went. Answering
  -- "where did that section go?" six months later is otherwise guesswork.
  label        TEXT,
  PRIMARY KEY (module_name, block_name)
);

COMMENT ON TABLE ipy_block_tombstone IS
  'Sections an administrator deleted. db/seed/helpers.ts skips these so re-seeding cannot resurrect them.';

ALTER TABLE ipy_block ADD COLUMN IF NOT EXISTS is_customised BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN ipy_block.is_customised IS
  'Set when an admin edits the section. The seed stops rewriting its label, width and collapsed state.';
