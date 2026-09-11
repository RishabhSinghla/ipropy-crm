-- Remove the old Properties `name` / Unit Name field completely.
--
-- Production has already stopped exposing it in field metadata, but its old
-- column can remain on the payload table.  That creates the worst kind of
-- import problem: a heading looks valid to an old spreadsheet but no CRM
-- field owns it.  Full Name is the live, mandatory property identity now.

DO $remove_property_name$
DECLARE
  property_module uuid;
  stored_values bigint := 0;
BEGIN
  SELECT id INTO property_module FROM ipy_module WHERE name = 'properties';
  IF property_module IS NULL THEN RETURN; END IF;

  -- Existing values are retained in the CRM's recoverable dropped-column
  -- archive rather than silently discarded. They are no longer part of the
  -- active Property schema and cannot appear in imports or forms.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'ipy_e_properties' AND column_name = 'name') THEN
    INSERT INTO ipy_dropped_column (table_name, column_name, record_id, value)
      SELECT 'ipy_e_properties', 'name', record_id, name::text
        FROM ipy_e_properties WHERE name IS NOT NULL;
    GET DIAGNOSTICS stored_values = ROW_COUNT;
  END IF;

  INSERT INTO ipy_field_tombstone (module_name, field_name, storage, column_name, had_values)
    VALUES ('properties', 'name', 'column', 'name', stored_values)
    ON CONFLICT (module_name, field_name) DO UPDATE SET had_values = EXCLUDED.had_values;

  DELETE FROM ipy_field WHERE module_id = property_module AND name = 'name';

  -- Nothing in the active schema may continue to depend on the removed name.
  UPDATE ipy_module
     SET label_fields = '["full_name"]'::jsonb,
         duplicate_check_fields = '["full_name","locality","floor"]'::jsonb
   WHERE id = property_module;

  UPDATE ipy_view
     SET columns = (SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
                      FROM jsonb_array_elements_text(columns) AS item WHERE item <> 'name'),
         sort_by = CASE WHEN sort_by = 'name' THEN NULL ELSE sort_by END,
         group_by = CASE WHEN group_by = 'name' THEN NULL ELSE group_by END
   WHERE module_id = property_module;

  UPDATE ipy_layout
     SET config = replace(config::text, '"name"', '"full_name"')::jsonb
   WHERE module_id = property_module AND config::text LIKE '%"name"%';

  ALTER TABLE ipy_e_properties DROP COLUMN IF EXISTS name;
END $remove_property_name$;
