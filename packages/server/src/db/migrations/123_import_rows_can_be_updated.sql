-- An imported row can now update an existing record, not only create one.
--
-- The importer grew four modes — create, update, create-or-update, and add
-- only what is missing — because a property database kept in Excel is mostly a
-- refresh of records that already exist. `ipy_import_row.outcome` only allowed
-- the four things an import could do before that, so an update row failed its
-- own audit write and took the import down with it.
ALTER TABLE ipy_import_row DROP CONSTRAINT IF EXISTS ipy_import_row_outcome_check;
ALTER TABLE ipy_import_row ADD CONSTRAINT ipy_import_row_outcome_check
  CHECK (outcome = ANY (ARRAY['created', 'updated', 'skipped', 'failed', 'duplicate']));
