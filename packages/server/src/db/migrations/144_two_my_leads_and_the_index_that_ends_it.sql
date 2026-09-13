-- The second "My Leads", for the third time — and the constraint that ends it.
--
-- Migration 135 tried to remove it and matched on `COALESCE(seed_key, name)`,
-- which kept the row it was aiming at. Migration 140 tried again and deleted
-- *non-system* views colliding with a system name. The switcher still shows
-- two, so the survivor is a **system** view: `idx_view_seed_key` is unique on
-- (module_id, seed_key) where seed_key is not null, so two rows can only both
-- be called "My Leads" if at least one of them has no seed_key — an old seeded
-- row from before that column existed. 140 skipped it by design.
--
-- Two fixes have now been written against the symptom. This one is against the
-- shape: dedupe whatever is there, then make the state unrepresentable.
--
-- Which copy survives is not arbitrary. The row carrying `seed_key` must be
-- the one kept, because `upsertViews` looks a seeded view up **by seed_key**
-- (db/seed/helpers.ts) — delete that one and the next cold start recreates it,
-- and the duplicate is back with a different id.

-- 1. A personal override belongs to a view. If the view it overrides is about
--    to go, move the override to the copy that survives — those are somebody's
--    own columns and filters, and 140 already recorded why throwing them away
--    is not acceptable.
--
--    `idx_view_override_per_user` is unique on (overrides_view_id, owner_id),
--    so somebody who had edited *both* copies cannot be moved onto the keeper;
--    that one override is dropped instead. Deleted first, because the UPDATE
--    below would otherwise abort the whole migration on the constraint.
CREATE TEMP TABLE view_dedupe ON COMMIT DROP AS
SELECT v.id,
       first_value(v.id) OVER (
         PARTITION BY v.module_id, v.name
         ORDER BY (v.seed_key IS NOT NULL) DESC, v.created_at, v.id
       ) AS keeper
  FROM ipy_view v
 WHERE v.is_system = true
   AND v.overrides_view_id IS NULL;

DELETE FROM ipy_view o
 USING view_dedupe d
 WHERE o.overrides_view_id = d.id
   AND d.id <> d.keeper
   AND EXISTS (
     SELECT 1 FROM ipy_view keep
      WHERE keep.overrides_view_id = d.keeper
        AND keep.owner_id IS NOT DISTINCT FROM o.owner_id
   );

UPDATE ipy_view o
   SET overrides_view_id = d.keeper
  FROM view_dedupe d
 WHERE o.overrides_view_id = d.id
   AND d.id <> d.keeper;

-- 2. The duplicates themselves.
DELETE FROM ipy_view v
 USING view_dedupe d
 WHERE v.id = d.id
   AND d.id <> d.keeper;

-- 3. 140 again, for anything created since it ran. A user-made view named
--    exactly after a built-in one reads as a duplicate in the switcher even
--    though the rows are unrelated. The views API refuses that name now; this
--    clears whatever was made before it did.
DELETE FROM ipy_view v
USING ipy_module m
WHERE m.id = v.module_id
  AND v.is_system = false
  AND v.overrides_view_id IS NULL
  AND EXISTS (
    SELECT 1 FROM ipy_view sys
     WHERE sys.module_id = v.module_id
       AND sys.is_system = true
       AND sys.name = v.name
  );

-- 4. And now it cannot happen again, whatever a future migration or a future
--    seed believes. A partial index because overrides are *supposed* to carry
--    the name of the view they override.
CREATE UNIQUE INDEX IF NOT EXISTS idx_view_one_system_name_per_module
    ON ipy_view (module_id, name)
 WHERE is_system = true AND overrides_view_id IS NULL;
