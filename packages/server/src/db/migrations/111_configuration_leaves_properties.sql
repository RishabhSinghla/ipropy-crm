-- Configuration goes from Properties, entirely.
--
-- The owner's words: "I have totally removed configuration field... delete
-- the configuration text field... no configuration I would ever see." This
-- business only ever used the "2 BHK" picklist to mean bedroom count, and
-- Properties already carries that as a plain number (`bedrooms`) — the two
-- fields were saying the same thing twice.
--
-- What stays: Contacts (leads) keeps its own `configuration` field — a
-- buyer's desired BHK(s) — because buyer matching reads it by that exact API
-- name (FIELDS_USED_IN_CODE refuses to rename it) and the Matching Setup
-- admin panel maps it to Properties.bedrooms. Only its *label* changes
-- (handled by the seed, not here). Every statement below is scoped to the
-- properties module specifically, because "configuration" is also a real
-- field name on leads — an unscoped rewrite would corrupt that one too.

-- 0. Carry whatever a property already had into bedrooms first, so nothing
--    is silently lost. "1.5 BHK" / "2.5 BHK" floor to the full bedroom count
--    (the half is a study, not a bedroom); "4+ BHK" reads as 4; "Duplex" /
--    "Plot" / "Commercial" have no bedroom count to carry and are left null.
--    Never overwrites a bedroom count someone already entered by hand.
UPDATE ipy_e_properties
   SET bedrooms = FLOOR((regexp_match(configuration, '^([0-9.]+)'))[1]::numeric)::int
 WHERE bedrooms IS NULL
   AND configuration ~ '^[0-9.]+\+?\s*(BHK|RK)';

-- 1. Tombstone it, so the seed does not rebuild it.
INSERT INTO ipy_field_tombstone (module_name, field_name, storage, column_name, had_values)
SELECT 'properties', 'configuration', 'column', 'configuration',
       (SELECT count(*) FROM ipy_e_properties WHERE configuration IS NOT NULL)
ON CONFLICT (module_name, field_name) DO NOTHING;

-- 2. Saved views on Properties: columns, sort/group, and any filter naming it.
--    "bedrooms" takes the column's place if the view does not already show
--    it, so a list that showed "Configuration" does not just lose a column.
UPDATE ipy_view
   SET columns = (
     SELECT COALESCE(jsonb_agg(c), '[]'::jsonb) FROM (
       SELECT c FROM jsonb_array_elements(columns) c WHERE c #>> '{}' <> 'configuration'
       UNION ALL
       SELECT '"bedrooms"'::jsonb WHERE NOT (columns ? 'bedrooms')
     ) x
   )
 WHERE module_id = (SELECT id FROM ipy_module WHERE name = 'properties')
   AND columns ? 'configuration';

UPDATE ipy_view SET sort_by = 'bedrooms'
 WHERE module_id = (SELECT id FROM ipy_module WHERE name = 'properties') AND sort_by = 'configuration';
UPDATE ipy_view SET group_by = 'bedrooms'
 WHERE module_id = (SELECT id FROM ipy_module WHERE name = 'properties') AND group_by = 'configuration';

UPDATE ipy_view
   SET filter = replace(filter::text, '"field":"configuration"', '"field":"bedrooms"')::jsonb
 WHERE module_id = (SELECT id FROM ipy_module WHERE name = 'properties')
   AND filter IS NOT NULL AND filter::text LIKE '%"field":"configuration"%';

-- 3. Layout blocks, dashboard tiles and workflows — properties-scoped only.
UPDATE ipy_layout
   SET config = jsonb_set(config, '{blocks}', COALESCE((
           SELECT jsonb_agg(
                    CASE WHEN b ? 'fields'
                      THEN jsonb_set(b, '{fields}',
                             COALESCE((SELECT jsonb_agg(f) FROM jsonb_array_elements(b->'fields') f
                                        WHERE f #>> '{}' <> 'configuration'), '[]'::jsonb))
                      ELSE b END)
             FROM jsonb_array_elements(config->'blocks') b
         ), '[]'::jsonb))
 WHERE module_id = (SELECT id FROM ipy_module WHERE name = 'properties')
   AND config ? 'blocks' AND config::text LIKE '%configuration%';

UPDATE ipy_dashboard_widget
   SET config = replace(config::text, '"configuration"', '"bedrooms"')::jsonb
 WHERE config->>'module' = 'properties' AND config::text LIKE '%configuration%';

UPDATE ipy_workflow
   SET conditions = replace(conditions::text, '"field":"configuration"', '"field":"bedrooms"')::jsonb
 WHERE module_id = (SELECT id FROM ipy_module WHERE name = 'properties')
   AND conditions IS NOT NULL AND conditions::text LIKE '%"field":"configuration"%';

UPDATE ipy_workflow_task t
   SET config = t.config - 'writeTo'
  FROM ipy_workflow w
 WHERE t.workflow_id = w.id
   AND w.module_id = (SELECT id FROM ipy_module WHERE name = 'properties')
   AND t.config::text LIKE '%configuration%';

-- A field's own config can name another field (conditional visibility,
-- formulas) — properties-scoped, same as renameFieldEverywhere's own sweep.
UPDATE ipy_field
   SET config = replace(config::text, '"configuration"', '"bedrooms"')::jsonb
 WHERE module_id = (SELECT id FROM ipy_module WHERE name = 'properties')
   AND name <> 'configuration'
   AND config::text LIKE '%configuration%';

-- 4. The metadata row itself.
DELETE FROM ipy_field
 WHERE name = 'configuration'
   AND module_id = (SELECT id FROM ipy_module WHERE name = 'properties');

-- 5. Storage last.
ALTER TABLE ipy_e_properties DROP COLUMN IF EXISTS configuration;
