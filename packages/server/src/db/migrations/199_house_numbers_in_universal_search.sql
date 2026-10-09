-- The owner explicitly requests house-number search. Preserve every other
-- field's searchability and all record values; append only existing house text.
DO $$
DECLARE item RECORD; expression TEXT;
BEGIN
  FOR item IN
    SELECT f.id, f.name, f.column_name, f.storage, m.id AS module_id, m.table_name
    FROM ipy_field f JOIN ipy_module m ON m.id=f.module_id
    WHERE f.is_active AND f.display_type <> 'hidden'
      AND (f.name IN ('unit_number','unit_no','house_no','house_number')
        OR f.column_name IN ('unit_number','unit_no','house_no','house_number')
        OR f.label ~* '(house|unit)\s*(no\.?|number)$')
  LOOP
    IF to_regclass(item.table_name) IS NULL THEN CONTINUE; END IF;
    IF item.storage = 'json' THEN
      expression := format('e.custom_fields->>%L',item.name);
    ELSE
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name=item.table_name AND column_name=item.column_name)
      THEN CONTINUE; END IF;
      expression := format('e.%I::text',item.column_name);
    END IF;
    UPDATE ipy_field SET searchable=true WHERE id=item.id;
    EXECUTE format('UPDATE ipy_record r SET search_text=concat_ws('' '',r.search_text,%s)
      FROM %I e WHERE e.record_id=r.id AND r.module_id=$1
      AND nullif(%s,'''') IS NOT NULL AND strpos(coalesce(r.search_text,''''),%s)=0',
      expression,item.table_name,expression,expression) USING item.module_id;
  END LOOP;
END $$;
