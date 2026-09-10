-- Fresh CRM installs have no legacy `matching.field_map` setting to migrate.
-- Seed the same useful defaults directly as permanent Field-ID mappings.
INSERT INTO ipy_field_mapping (
  source_module_id, target_module_id, source_field_internal_id,
  target_field_internal_id, purpose, config, is_active
)
SELECT sm.id, tm.id, sf.internal_id, tf.internal_id, 'matching',
       jsonb_build_object('seeded', true), true
  FROM (VALUES
    ('budget', 'base_price'),
    ('configuration', 'bedrooms'),
    ('preferred_locations', 'locality'),
    ('area', 'carpet_area')
  ) AS defaults(source_name, target_name)
  JOIN ipy_module sm ON sm.name = 'leads'
  JOIN ipy_module tm ON tm.name = 'properties'
  JOIN ipy_field sf ON sf.module_id = sm.id AND sf.name = defaults.source_name
  JOIN ipy_field tf ON tf.module_id = tm.id AND tf.name = defaults.target_name
ON CONFLICT DO NOTHING;
