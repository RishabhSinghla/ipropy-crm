-- ===========================================================================
-- iPropy CRM — 129: matching had two of its four rules pointing at nothing
--
-- Reported as "matching setup isn't working at all". It wasn't, and neither
-- the page nor the engine said so.
--
-- `ipy_field_mapping` holds the Contact↔Property pairs by permanent field id,
-- which is right: a field's *name* changes and its id does not. What nobody
-- allowed for is a field being deleted and re-created — a rename that went
-- through delete-and-add, or a re-seed after a field was removed — because the
-- replacement carries a **new** internal id. The mapping row survives, pointing
-- at an id no field has any more.
--
-- `matchingConfig()` resolved each row against the registry and dropped
-- silently anything it could not find (`contact && property ? [...] : []`). So
-- on this database:
--
--     budget              -> Base Price          resolved
--     preferred_locations -> Locality            resolved
--     configuration       -> (deleted)           dropped
--     area                -> (deleted)           dropped
--
-- Bedrooms and size — the two things anybody actually matches on — were not
-- being compared at all. Every unit scored the same middling number off
-- facing and locality alone, the Matching Setup page listed two rules where
-- four had been saved, and nothing anywhere reported an error.
--
-- This repoints a broken row at whichever field now holds that role, resolved
-- on `column_name` (stable across a rename) through the same candidate lists
-- `db/seed/matchingMappings.ts` uses, and deletes any row that still cannot be
-- resolved so the admin sees an honest list and can re-add the pair by hand.
--
-- The silence is fixed in code alongside this: `matchingConfig()` now logs a
-- dropped pair, and the admin endpoint returns it flagged rather than hiding
-- it, so the next time this happens the page says which rule is broken.
-- ===========================================================================

DO $$
DECLARE
  leads_id   UUID;
  props_id   UUID;
  pair       RECORD;
  new_target TEXT;
  new_source TEXT;
  -- source column -> the property columns that can answer it, best first.
  intents    TEXT[][] := ARRAY[
    ARRAY['budget',              'base_price,demand,total_price'],
    ARRAY['configuration',       'configuration,bedrooms'],
    ARRAY['preferred_locations', 'locality,city'],
    ARRAY['area',                'carpet_area,area,built_up_area']
  ];
  intent     TEXT[];
BEGIN
  SELECT id INTO leads_id FROM ipy_module WHERE name = 'leads';
  SELECT id INTO props_id FROM ipy_module WHERE name = 'properties';
  IF leads_id IS NULL OR props_id IS NULL THEN RETURN; END IF;

  FOR pair IN
    SELECT fm.id,
           sf.column_name AS source_column,
           (sf.internal_id IS NULL) AS source_broken,
           (tf.internal_id IS NULL) AS target_broken
      FROM ipy_field_mapping fm
      LEFT JOIN ipy_field sf
        ON sf.internal_id = fm.source_field_internal_id AND sf.module_id = leads_id AND sf.is_active
      LEFT JOIN ipy_field tf
        ON tf.internal_id = fm.target_field_internal_id AND tf.module_id = props_id AND tf.is_active
     WHERE fm.purpose = 'matching'
       AND fm.source_module_id = leads_id AND fm.target_module_id = props_id
       AND (sf.internal_id IS NULL OR tf.internal_id IS NULL)
  LOOP
    -- A row whose *contact* side is gone cannot be repaired: nothing left on
    -- it says what it used to compare.
    IF pair.source_broken THEN
      DELETE FROM ipy_field_mapping WHERE id = pair.id;
      CONTINUE;
    END IF;

    new_target := NULL;
    FOREACH intent SLICE 1 IN ARRAY intents LOOP
      IF intent[1] = pair.source_column THEN
        SELECT f.internal_id INTO new_target
          FROM ipy_field f
         WHERE f.module_id = props_id AND f.is_active
           AND f.column_name = ANY (string_to_array(intent[2], ','))
         ORDER BY array_position(string_to_array(intent[2], ','), f.column_name)
         LIMIT 1;
      END IF;
    END LOOP;

    IF new_target IS NULL THEN
      DELETE FROM ipy_field_mapping WHERE id = pair.id;
    ELSE
      -- The unique constraint covers (source, target, purpose): if the repair
      -- lands on a pair that already exists, this row is a duplicate.
      IF EXISTS (
        SELECT 1 FROM ipy_field_mapping x
         WHERE x.source_module_id = leads_id AND x.target_module_id = props_id
           AND x.purpose = 'matching' AND x.target_field_internal_id = new_target
           AND x.id <> pair.id
           AND x.source_field_internal_id = (
             SELECT fm2.source_field_internal_id FROM ipy_field_mapping fm2 WHERE fm2.id = pair.id
           )
      ) THEN
        DELETE FROM ipy_field_mapping WHERE id = pair.id;
      ELSE
        UPDATE ipy_field_mapping
           SET target_field_internal_id = new_target, updated_at = now()
         WHERE id = pair.id;
      END IF;
    END IF;
  END LOOP;
END $$;
