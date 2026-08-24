-- Rows that a unique index should have made impossible.
--
-- Found because the website's Configuration dropdown listed "2 BHK" twice.
-- Underneath it was worse: 32 duplicate picklist values across six dropdowns,
-- and a duplicate `leads.ai_scored_at` field.
--
-- The tables have had their unique indexes all along, the indexes report valid,
-- and inserting a duplicate today is still rejected. What had happened is that
-- the btree on text stopped matching some rows, which is what a collation change
-- underneath an index does. `pg_database.datcollversion` was NULL here, so
-- Postgres had no baseline to compare against and never raised its usual
-- warning.
--
-- The damage is not just cosmetic. `db/seed/helpers.ts` relies on
-- `ON CONFLICT (module_id, name) DO NOTHING` and
-- `ON CONFLICT (picklist_id, value) DO NOTHING` to be idempotent. When the index
-- cannot find the existing row, the conflict never fires and the seed INSERTS
-- instead of skipping — so every cold start since the drift has been quietly
-- adding another copy. That is why the counts are what they are.
--
-- Deduplicate first, because REINDEX on a unique index fails while duplicates
-- exist. Then rebuild, so the constraint starts working again and the seed goes
-- back to being idempotent.

-- Picklist values. Keep a default over a non-default, then the lower sequence,
-- then the older row. Records store the value string rather than this row's id,
-- so dropping the twin changes nothing anybody has entered.
DELETE FROM ipy_picklist_value a
 USING ipy_picklist_value b
 WHERE a.picklist_id = b.picklist_id
   AND a.value = b.value
   AND a.id <> b.id
   AND (b.is_default, -b.sequence, b.id) > (a.is_default, -a.sequence, a.id);

-- Fields. Keep the one an admin has customised, then the one that still sits in
-- a section, then the original. Layouts and views name fields by `name`, not by
-- id, so the survivor is the one that matters.
DELETE FROM ipy_field a
 USING ipy_field b
 WHERE a.module_id = b.module_id
   AND a.name = b.name
   AND a.id <> b.id
   AND (b.is_customised, (b.block_id IS NOT NULL), b.created_at)
       > (a.is_customised, (a.block_id IS NOT NULL), a.created_at);

REINDEX TABLE ipy_picklist_value;
REINDEX TABLE ipy_field;
REINDEX TABLE ipy_picklist;
REINDEX TABLE ipy_block;
REINDEX TABLE ipy_setting;
REINDEX TABLE ipy_module;
