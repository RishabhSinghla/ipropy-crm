-- Fresh CRM installs have no legacy `matching.field_map` setting to migrate.
-- Seed the same useful defaults directly as permanent Field-ID mappings.
--
-- Resolved on `column_name`, never on `name`, and through a *list* of candidate
-- columns rather than one, because the two databases this has to satisfy have
-- drifted apart:
--
--   what it means   a fresh install has   production has
--   ------------------------------------------------------------------
--   the price       base_price            base_price (field renamed `demand`)
--   the BHK         bedrooms              configuration (field `bedrooms`)
--   the location    locality              locality (field `preferred_locations`)
--   the size        area                  carpet_area (field `area_size`)
--
-- A name would have matched one of the four on production, and one is worse
-- than none: `matchingConfig` prefers any mapping row over the legacy setting,
-- so budget, location and size would have silently stopped counting toward a
-- match while the screen went on showing a confident percentage.
--
-- Candidates are tried in order and the first that exists wins, so this seeds
-- the same four intentions on either database and adds nothing on a CRM where
-- an admin has already mapped these by hand.
INSERT INTO ipy_field_mapping (
  source_module_id, target_module_id, source_field_internal_id,
  target_field_internal_id, purpose, config, is_active
)
SELECT sm.id, tm.id, sf.internal_id, tf.internal_id, 'matching',
       jsonb_build_object('seeded', true, 'intent', defaults.intent), true
  FROM (VALUES
    ('budget',   ARRAY['budget'],              ARRAY['base_price','demand','total_price']),
    ('bhk',      ARRAY['configuration'],       ARRAY['configuration','bedrooms']),
    ('location', ARRAY['preferred_locations'], ARRAY['locality','city']),
    ('size',     ARRAY['area'],                ARRAY['carpet_area','area','built_up_area'])
  ) AS defaults(intent, source_columns, target_columns)
  JOIN ipy_module sm ON sm.name = 'leads'
  JOIN ipy_module tm ON tm.name = 'properties'
 CROSS JOIN LATERAL (
   SELECT f.internal_id FROM ipy_field f
    WHERE f.module_id = sm.id AND f.is_active
      AND f.column_name = ANY (defaults.source_columns)
    ORDER BY array_position(defaults.source_columns, f.column_name)
    LIMIT 1
 ) sf
 CROSS JOIN LATERAL (
   SELECT f.internal_id FROM ipy_field f
    WHERE f.module_id = tm.id AND f.is_active
      AND f.column_name = ANY (defaults.target_columns)
    ORDER BY array_position(defaults.target_columns, f.column_name)
    LIMIT 1
 ) tf
ON CONFLICT DO NOTHING;
