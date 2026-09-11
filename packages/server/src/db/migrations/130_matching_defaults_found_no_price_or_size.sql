-- ===========================================================================
-- iPropy CRM — 130: the matching defaults looked for fields that no longer exist
--
-- Migration 120 and `db/seed/matchingMappings.ts` seed four intentions —
-- price, BHK, location, size — by resolving a list of candidate columns. Both
-- lists were written against an older field set and have since been outlived
-- by production:
--
--     price   base_price, demand, total_price      all three deleted
--     size    area, carpet_area, built_up_area     all three deleted
--     BHK     configuration                        resolves, but the contact
--                                                  side is `multipicklist`,
--                                                  which the type guard added
--                                                  alongside this did not allow
--
-- Production's price is `asking_price` and its size `area_size`, both created
-- through the admin UI, so both live in `custom_fields` and their
-- `column_name` is the JSONB key rather than a real column.
--
-- Production itself is fine today: somebody mapped those pairs by hand after
-- migration 129. What was broken is every path that rebuilds them — a fresh
-- tenant, a cold-start re-seed, or a field deleted and re-created — which got
-- location alone and reported a confident match percentage computed without
-- price, size or bedrooms. That is the same silent shape 129 was written for,
-- one field set later, so this repairs the data and the lists are corrected in
-- the seed alongside it.
--
-- Additive and idempotent: a pair that resolves is never touched, so this
-- no-ops on production and on any CRM an admin has already mapped by hand.
-- ===========================================================================

DO $$
DECLARE
  leads_id UUID;
  props_id UUID;
  intent   TEXT[];
  -- intent, contact-side candidates, property-side candidates, allowed uitypes.
  -- Best-first; today's names lead, the older ones stay behind them so this
  -- seeds the same four intentions on a database of any age.
  --
  -- The uitype list is the load-bearing part. An amount field carries a
  -- companion holding its unit, and on production the size field's JSONB key
  -- is literally `area_unit` — indistinguishable by name from that companion.
  -- Matching size against a column of the word "Sq Ft" would score every unit
  -- identically.
  intents  TEXT[][] := ARRAY[
    ARRAY['budget',              'budget',
          'asking_price,base_price,demand,total_price',
          'currency,number,decimal,integer,double'],
    ARRAY['bhk',                 'configuration',
          'configuration,bedrooms',
          'picklist,multipicklist,string,text,integer,number'],
    ARRAY['location',            'preferred_locations',
          'locality,city',
          'string,text,picklist,multipicklist'],
    ARRAY['size',                'area_size,area,area_unit',
          'area_size,carpet_area,area,built_up_area',
          'area,number,decimal,integer,double']
  ];
  -- `internal_id` is the permanent `fld_…` text id, not a UUID; the module
  -- ids beside it are UUIDs.
  src_id   TEXT;
  tgt_id   TEXT;
BEGIN
  SELECT id INTO leads_id FROM ipy_module WHERE name = 'leads';
  SELECT id INTO props_id FROM ipy_module WHERE name = 'properties';
  IF leads_id IS NULL OR props_id IS NULL THEN RETURN; END IF;

  -- A row pointing at a field that no longer exists compares nothing and is
  -- invisible on the Matching Setup page. 129 cleared the ones it could not
  -- repair; this clears any that have broken since, so the loop below can
  -- re-resolve that intention rather than skipping it as already present.
  DELETE FROM ipy_field_mapping fm
   WHERE fm.purpose = 'matching'
     AND (NOT EXISTS (SELECT 1 FROM ipy_field f
                       WHERE f.internal_id = fm.source_field_internal_id AND f.is_active)
       OR NOT EXISTS (SELECT 1 FROM ipy_field f
                       WHERE f.internal_id = fm.target_field_internal_id AND f.is_active));

  FOREACH intent SLICE 1 IN ARRAY intents LOOP
    SELECT f.internal_id INTO src_id
      FROM ipy_field f
     WHERE f.module_id = leads_id AND f.is_active
       AND f.column_name = ANY (string_to_array(intent[2], ','))
       AND f.uitype = ANY (string_to_array(intent[4], ','))
     ORDER BY array_position(string_to_array(intent[2], ','), f.column_name)
     LIMIT 1;

    SELECT f.internal_id INTO tgt_id
      FROM ipy_field f
     WHERE f.module_id = props_id AND f.is_active
       AND f.column_name = ANY (string_to_array(intent[3], ','))
       AND f.uitype = ANY (string_to_array(intent[4], ','))
     ORDER BY array_position(string_to_array(intent[3], ','), f.column_name)
     LIMIT 1;

    CONTINUE WHEN src_id IS NULL OR tgt_id IS NULL;

    -- Only when that contact field is mapped to nothing at all. An admin who
    -- pointed budget somewhere deliberate keeps their choice.
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM ipy_field_mapping fm
       WHERE fm.purpose = 'matching' AND fm.is_active
         AND fm.source_field_internal_id = src_id
    );

    INSERT INTO ipy_field_mapping (
      source_module_id, target_module_id, source_field_internal_id,
      target_field_internal_id, purpose, config, is_active
    )
    VALUES (leads_id, props_id, src_id, tgt_id, 'matching',
            jsonb_build_object('seeded', true, 'intent', intent[1]), true)
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;
