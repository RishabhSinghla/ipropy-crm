-- One column, one field. And the Area / Size he already had.
--
-- Two mistakes to undo, both mine, both from reading field *names* on
-- production instead of what those fields point at.
--
-- 1. Properties already had an Area / Size field: it is the Carpet Area field,
--    renamed. Migration 113 looked for a field *named* `carpet_area`, did not
--    find one, and built a second area field beside his — same numbers, two
--    boxes on the form. His is the one to keep, and the unit dropdown he asked
--    for belongs on it.
--
-- 2. Every field he has renamed acquired a twin. `upsertField` conflicts on
--    (module_id, name), a rename changes the name and never the column, so the
--    seed inserted the original name back beside the new one on the next cold
--    start — two fields writing one column, the same value in two places, each
--    edit overwriting the last. Properties has full_name/name,
--    assigned_to/owner_id, block_tower/tower and demand/base_price; Contacts
--    has lead_status/status. The seed no longer does this (see
--    `upsertField`), but the pairs already made need collapsing.
--
-- Which twin survives is decided by `is_customised`, the flag the field editor
-- sets: that is the row a person has touched, and the other is the one the
-- seed put there. Where that cannot separate them, the older row wins — it is
-- the one whose id every layout and view already names.

-- 1. The duplicate area field, only where his own still exists.
DO $area$
DECLARE
  his   text;
  mine  uuid;
BEGIN
  -- The field that owns the carpet_area column, whatever he has called it.
  SELECT f.name INTO his
    FROM ipy_field f JOIN ipy_module m ON m.id = f.module_id
   WHERE m.name = 'properties' AND f.column_name = 'carpet_area' AND f.storage = 'column'
   LIMIT 1;

  IF his IS NULL THEN
    RAISE NOTICE 'no field owns carpet_area here — nothing to collapse';
    RETURN;
  END IF;

  -- The unit beside the size, which is what he asked for in the first place.
  UPDATE ipy_field f
     SET config = COALESCE(f.config, '{}'::jsonb) ||
                  '{"min":0,"unitField":"area_unit","unitOptions":[{"value":"sqft","label":"Sq.ft."},{"value":"sqyd","label":"Sq.yd."}]}'::jsonb
    FROM ipy_module m
   WHERE m.id = f.module_id AND m.name = 'properties' AND f.name = his;

  SELECT f.id INTO mine
    FROM ipy_field f JOIN ipy_module m ON m.id = f.module_id
   WHERE m.name = 'properties' AND f.column_name = 'area' AND f.storage = 'column'
   LIMIT 1;

  IF mine IS NULL THEN RETURN; END IF;

  -- Values first. `area` only ever held a copy of carpet_area, but "only ever"
  -- is a claim about the past and this is a DROP COLUMN.
  INSERT INTO ipy_dropped_column (table_name, column_name, record_id, value)
    SELECT 'ipy_e_properties', 'area', record_id, area::text
      FROM ipy_e_properties WHERE area IS NOT NULL;

  DELETE FROM ipy_field WHERE id = mine;
  INSERT INTO ipy_field_tombstone (module_name, field_name, storage, column_name, had_values)
    VALUES ('properties', 'area', 'column', 'area', 0)
    ON CONFLICT (module_name, field_name) DO NOTHING;
  ALTER TABLE ipy_e_properties DROP COLUMN IF EXISTS area;

  RAISE NOTICE 'Area / Size is now %, with its unit dropdown; the duplicate is gone', his;
END $area$;

-- 2. Every remaining pair of fields sharing one column.
DO $twins$
DECLARE
  pair   record;
  keep   uuid;
  drop_n int := 0;
BEGIN
  FOR pair IN
    SELECT f.module_id, f.column_name
      FROM ipy_field f
     WHERE f.storage = 'column'
     GROUP BY f.module_id, f.column_name
    HAVING count(*) > 1
  LOOP
    -- The one a person has edited, else the one that has been there longest.
    SELECT id INTO keep
      FROM ipy_field
     WHERE module_id = pair.module_id AND column_name = pair.column_name
     ORDER BY is_customised DESC, created_at ASC, id ASC
     LIMIT 1;

    -- The losers leave every layout with them, or the Layout Designer goes on
    -- offering a field that is not there. `pruneFieldRefs` would catch this on
    -- the next boot too; doing it here keeps the two in step immediately.
    UPDATE ipy_layout l
       SET config = jsonb_set(l.config, '{blocks}', COALESCE((
             SELECT jsonb_agg(CASE WHEN b ? 'fields'
                      THEN jsonb_set(b, '{fields}', COALESCE((
                             SELECT jsonb_agg(x) FROM jsonb_array_elements_text(b->'fields') x
                              WHERE x NOT IN (SELECT name FROM ipy_field
                                               WHERE module_id = pair.module_id
                                                 AND column_name = pair.column_name
                                                 AND id <> keep)), '[]'::jsonb))
                      ELSE b END)
               FROM jsonb_array_elements(l.config->'blocks') b), '[]'::jsonb))
     WHERE l.module_id = pair.module_id AND l.config ? 'blocks';

    DELETE FROM ipy_field
     WHERE module_id = pair.module_id AND column_name = pair.column_name AND id <> keep;
    GET DIAGNOSTICS drop_n = ROW_COUNT;

    IF drop_n > 0 THEN
      RAISE NOTICE 'collapsed % duplicate field(s) on %', drop_n, pair.column_name;
    END IF;
  END LOOP;
END $twins$;
