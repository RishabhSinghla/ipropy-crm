-- The Vtiger import brought the numeric area across correctly but, where the
-- source had no unit, stored the default `sqft` companion value.  This business
-- uses square yards.  Per the requested correction, this migration changes
-- only that companion label: values such as 1200 remain 1200 (no conversion).
--
-- Find the metadata pairing instead of naming payload columns.  Field names
-- may have been customised; `unitField` identifies the companion that belongs
-- to each Area field in Leads and Inventory.
DO $$
DECLARE
  f RECORD;
  changed INT;
BEGIN
  FOR f IN
    SELECT mo.name AS module_name, mo.table_name, unit.storage, unit.column_name AS unit_key
      FROM ipy_field area
      JOIN ipy_module mo ON mo.id = area.module_id
      JOIN ipy_field unit ON unit.module_id = area.module_id
                        AND unit.name = area.config ->> 'unitField'
     WHERE mo.name IN ('leads', 'properties')
       AND area.is_active = true
       AND area.uitype = 'area'
       AND area.config ->> 'unitMaster' = 'area'
       AND unit.is_active = true
  LOOP
    IF f.storage = 'json' THEN
      EXECUTE format($sql$
        UPDATE %I
           SET custom_fields = jsonb_set(COALESCE(custom_fields, '{}'::jsonb), ARRAY[%L], '"sqyd"'::jsonb, true)
         WHERE regexp_replace(lower(COALESCE(custom_fields ->> %L, '')), '[^a-z]', '', 'g') IN ('sqft', 'squarefoot', 'squarefeet')
      $sql$, f.table_name, f.unit_key, f.unit_key);
    ELSE
      EXECUTE format($sql$
        UPDATE %I
           SET %I = 'sqyd'
         WHERE regexp_replace(lower(COALESCE(%I::text, '')), '[^a-z]', '', 'g') IN ('sqft', 'squarefoot', 'squarefeet')
      $sql$, f.table_name, f.unit_key, f.unit_key);
    END IF;
    GET DIAGNOSTICS changed = ROW_COUNT;
    RAISE NOTICE '142: changed % square-foot unit label(s) to sqyd for %.%', changed, f.module_name, f.unit_key;
  END LOOP;
END $$;
