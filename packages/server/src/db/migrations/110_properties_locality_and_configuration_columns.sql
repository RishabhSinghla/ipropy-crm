-- Properties import was failing every row in production:
--   column "locality" of relation "ipy_e_properties" does not exist
--   column "configuration" of relation "ipy_e_properties" does not exist
--
-- Both columns are in 002_entities.sql's CREATE TABLE and both fields are
-- seeded as storage = 'column' (realEstate.ts), so every environment that
-- ran 002 after these lines were added has them. Production's copy of
-- ipy_e_properties predates that edit — 002 is marked applied in
-- ipy_migration and never re-runs, so the file changing underneath an
-- already-applied migration left production's table behind the code. This
-- restores parity the forward-only way instead of editing 002.

ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS configuration TEXT;
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS locality      TEXT;

CREATE INDEX IF NOT EXISTS idx_prop_config ON ipy_e_properties(configuration);
CREATE INDEX IF NOT EXISTS idx_prop_city   ON ipy_e_properties(city, locality);
