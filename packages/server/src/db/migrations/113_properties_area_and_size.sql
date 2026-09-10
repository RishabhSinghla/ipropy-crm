-- Carpet Area goes; Properties gets one Area / Size with its unit beside it.
--
-- The owner's words: "Property has carpet area field, rip this off completely.
-- Area/Size field it also has, so input area unit Sq.ft./Sq.yd. dropdown right
-- next to it just like this Contacts has."
--
-- Contacts already works that way — one `area` field whose `unitField` points
-- at `area_unit`, rendered as a number with the unit dropdown inside the same
-- control. Properties had six separate area fields, a fixed "sqft" on each,
-- and an `area_unit` that was a free-text field nobody could pick from. This
-- makes the pair on Properties the same pair Contacts has, which is also what
-- lets buyer matching compare like with like: Faridabad quotes plots in gaj
-- and flats in square feet, and a number without its unit matches nothing
-- correctly.
--
-- Nothing is lost: every carpet area already recorded becomes the property's
-- Area / Size before the column goes.

-- 1. The new field's column, ahead of the seed that will describe it, because
--    step 2 has to write into it now.
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS area NUMERIC;

-- 2. Carry Carpet Area across. Guarded: `carpet_area` is an ordinary field an
--    admin may already have deleted permanently, which drops the column, and
--    a statement naming a missing column fails when Postgres *parses* it — no
--    WHERE clause can save it, so it has to be dynamic. This is the mistake
--    that killed the container at boot in 110.
DO $carry$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'ipy_e_properties' AND column_name = 'carpet_area') THEN
    EXECUTE 'UPDATE ipy_e_properties SET area = carpet_area WHERE area IS NULL AND carpet_area IS NOT NULL';
  END IF;
END $carry$;

-- 3. `area_unit` on Properties was seeded as free text while the identical
--    field on Contacts is a dropdown. Both are TEXT columns, so this is a
--    metadata change only — no data moves, and anything already typed in
--    survives (a stored value no option backs still renders; that rule is
--    older than this migration).
UPDATE ipy_field f
   SET uitype = 'picklist',
       config = COALESCE(f.config, '{}'::jsonb) || '{"picklist":"area_unit","colored":true}'::jsonb,
       display_type = 'hidden'
  FROM ipy_module m
 WHERE m.id = f.module_id AND m.name = 'properties'
   AND f.name = 'area_unit' AND f.uitype <> 'picklist';

UPDATE ipy_e_properties SET area_unit = 'sqft'
 WHERE area_unit IS NULL OR btrim(area_unit) = '';

-- 4. Tombstone Carpet Area so the seed cannot rebuild it.
INSERT INTO ipy_field_tombstone (module_name, field_name, storage, column_name, had_values)
SELECT 'properties', 'carpet_area', 'column', 'carpet_area',
       (SELECT count(*) FROM ipy_e_properties WHERE area IS NOT NULL)
ON CONFLICT (module_name, field_name) DO NOTHING;

-- 5. Everything that names it by name. `area` takes its place rather than the
--    reference simply being deleted — a saved view that showed Carpet Area
--    should show the size, not one column fewer. Every substitution is
--    properties-scoped: `area` and `carpet_area` are meaningful names on
--    Contacts too, and an unscoped rewrite would corrupt that module.
UPDATE ipy_view
   SET columns = (
     SELECT COALESCE(jsonb_agg(c), '[]'::jsonb) FROM (
       SELECT c FROM jsonb_array_elements(columns) c WHERE c #>> '{}' <> 'carpet_area'
       UNION ALL
       SELECT '"area"'::jsonb WHERE NOT (columns ? 'area')
     ) x
   )
 WHERE module_id = (SELECT id FROM ipy_module WHERE name = 'properties')
   AND columns ? 'carpet_area';

UPDATE ipy_view SET sort_by  = 'area' WHERE module_id = (SELECT id FROM ipy_module WHERE name = 'properties') AND sort_by  = 'carpet_area';
UPDATE ipy_view SET group_by = 'area' WHERE module_id = (SELECT id FROM ipy_module WHERE name = 'properties') AND group_by = 'carpet_area';

UPDATE ipy_view
   SET filter = replace(filter::text, '"field":"carpet_area"', '"field":"area"')::jsonb
 WHERE module_id = (SELECT id FROM ipy_module WHERE name = 'properties')
   AND filter IS NOT NULL AND filter::text LIKE '%"field":"carpet_area"%';

-- The layout keeps the position: Area / Size lands exactly where Carpet Area
-- stood, rather than at the end of whatever section it was in.
UPDATE ipy_layout
   SET config = jsonb_set(config, '{blocks}', COALESCE((
           SELECT jsonb_agg(
                    CASE WHEN b ? 'fields'
                      THEN jsonb_set(b, '{fields}', COALESCE((
                             -- Rename in place, then keep the first of any pair
                             -- that has now collided: a section already showing
                             -- Area / Size must not end up showing it twice
                             -- (migration 109 exists because that broke a form).
                             SELECT jsonb_agg(v ORDER BY ord)
                               FROM (
                                 SELECT v, min(ord) AS ord
                                   FROM (
                                     SELECT CASE WHEN f #>> '{}' = 'carpet_area' THEN '"area"'::jsonb ELSE f END AS v,
                                            ord
                                       FROM jsonb_array_elements(b->'fields') WITH ORDINALITY AS t(f, ord)
                                   ) mapped
                                  GROUP BY v
                               ) deduped
                           ), '[]'::jsonb))
                      ELSE b END)
             FROM jsonb_array_elements(config->'blocks') b
         ), '[]'::jsonb))
 WHERE module_id = (SELECT id FROM ipy_module WHERE name = 'properties')
   AND config ? 'blocks' AND config::text LIKE '%carpet_area%';

UPDATE ipy_dashboard_widget
   SET config = replace(config::text, '"carpet_area"', '"area"')::jsonb
 WHERE config->>'module' = 'properties' AND config::text LIKE '%carpet_area%';

UPDATE ipy_workflow
   SET conditions = replace(conditions::text, '"field":"carpet_area"', '"field":"area"')::jsonb
 WHERE module_id = (SELECT id FROM ipy_module WHERE name = 'properties')
   AND conditions IS NOT NULL AND conditions::text LIKE '%"field":"carpet_area"%';

UPDATE ipy_field
   SET config = replace(config::text, '"carpet_area"', '"area"')::jsonb
 WHERE module_id = (SELECT id FROM ipy_module WHERE name = 'properties')
   AND name <> 'carpet_area'
   AND config::text LIKE '%carpet_area%';

-- 6. The metadata row, then the storage.
DELETE FROM ipy_field
 WHERE name = 'carpet_area'
   AND module_id = (SELECT id FROM ipy_module WHERE name = 'properties');

ALTER TABLE ipy_e_properties DROP COLUMN IF EXISTS carpet_area;
