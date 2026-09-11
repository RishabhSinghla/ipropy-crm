-- ===========================================================================
-- iPropy CRM — 131: a unit label was sitting in the field that means the area
--
-- On production, 232 of 234 contacts held a non-numeric value under the key
-- that the "Area / Size" field reads, and every one of the two distinct values
-- is a unit from the area unit master. The field's JSONB key is `area_unit`,
-- which is the name its *companion* would carry.
--
-- So: a field called `area_unit`, holding "Sq Ft", was renamed to `area_size`
-- and retyped as an `area`. A rename moves the name and never the key, and
-- nothing converts what is already stored — so the label stayed exactly where
-- it was and is now read as the buyer's required size.
--
-- What that cost, none of it visible:
--
--   * Every contact's Area / Size column, and its export, showed a unit label
--     where a number belongs.
--   * `scoreProperty` guards the size term with `if (row.matched_area &&
--     req.area)`. `Number('Sq Ft')` is NaN, which is falsy, so the term was
--     skipped — for 232 of 234 contacts, silently, with a confident match
--     percentage computed from the remaining terms.
--   * The companion unit field was filled on 2 rows out of 234, so the unit
--     the buyer actually stated was being thrown away as well.
--
-- The repair moves the label to the companion that means it and clears the
-- numeric key. Nothing is lost: the value lands in the field whose whole job
-- is to hold it, and a row whose companion already says something is left
-- alone.
--
-- Driven by metadata rather than by the two key names, because the cause — a
-- rename outliving its data — is not specific to this field and will not be
-- specific to this module next time. Any numeric field whose `config.unitField`
-- names a companion is checked, on every entity table.
--
-- `unitField` holds the companion's **name**; the value is written to its
-- **column_name**. Those are the same string only until somebody renames it,
-- and here they already differ: the field named `area_size_unit` stores under
-- `area_unit_unit`.
-- ===========================================================================

DO $$
DECLARE
  f          RECORD;
  moved      INT;
BEGIN
  FOR f IN
    SELECT mo.name          AS module_name,
           mo.table_name    AS table_name,
           num.name         AS field_name,
           num.column_name  AS num_key,
           unit.column_name AS unit_key,
           CASE WHEN num.uitype = 'area' THEN 'area' ELSE 'budget_demand' END AS unit_kind
      FROM ipy_field num
      JOIN ipy_module mo   ON mo.id = num.module_id
      JOIN ipy_field unit  ON unit.module_id = num.module_id
                          AND unit.name = num.config ->> 'unitField'
     WHERE num.storage = 'json'
       AND unit.storage = 'json'
       AND num.uitype IN ('area', 'currency', 'number', 'decimal', 'integer', 'double')
       AND num.config ? 'unitField'
  LOOP
    EXECUTE format($fmt$
      UPDATE %I t
         SET custom_fields =
               jsonb_set(t.custom_fields - %L, ARRAY[%L],
                         to_jsonb(t.custom_fields ->> %L))
       WHERE coalesce(t.custom_fields ->> %L, '') <> ''
         AND NOT (t.custom_fields ->> %L ~ '^[0-9]+(\.[0-9]+)?$')
         AND coalesce(t.custom_fields ->> %L, '') = ''
         AND lower(trim(t.custom_fields ->> %L)) IN (
               SELECT lower(trim(um.value)) FROM ipy_unit_master um WHERE um.kind = %L
               UNION
               SELECT lower(trim(um.label)) FROM ipy_unit_master um WHERE um.kind = %L)
    $fmt$, f.table_name,
           f.num_key, f.unit_key, f.num_key,
           f.num_key, f.num_key, f.unit_key, f.num_key,
           f.unit_kind, f.unit_kind);
    GET DIAGNOSTICS moved = ROW_COUNT;
    IF moved > 0 THEN
      RAISE NOTICE '131: moved % unit label(s) from %.% into %',
        moved, f.module_name, f.field_name, f.unit_key;
    END IF;
  END LOOP;
END $$;
