-- Budget and Demand get their qualifier: Sq. ft., Sq. yd., or Total.
--
-- The area field made this shape already — a number box with a unit selector
-- welded to its right edge. The desk asked for the same thing on money:
-- "budget" on a contact and "demand" on a property are each one number plus
-- what the number is *per*, and a bare rupee figure loses that.

-- One dropdown serves both halves.
INSERT INTO ipy_picklist (name, label, is_global)
VALUES ('price_unit', 'Price Unit', true)
ON CONFLICT (name) DO UPDATE SET label = EXCLUDED.label;

INSERT INTO ipy_picklist_value (picklist_id, value, label, sequence, is_active, is_default)
SELECT p.id, v.value, v.label, v.seq, true, v.value = 'total'
  FROM ipy_picklist p
  JOIN (VALUES
    ('sqft', 'Sq. ft.', 0),
    ('sqyd', 'Sq. yd.', 1),
    ('total', 'Total',    2)
  ) AS v(value, label, seq) ON true
 WHERE p.name = 'price_unit'
ON CONFLICT (picklist_id, value) DO UPDATE SET label = EXCLUDED.label;

-- Contact side: the companion field, defaulted to Total (a buyer's budget is
-- almost always the whole figure), plus the binding on budget itself.
ALTER TABLE ipy_e_leads ADD COLUMN IF NOT EXISTS budget_unit TEXT;
UPDATE ipy_e_leads SET budget_unit = 'total' WHERE budget_unit IS NULL;

UPDATE ipy_field f
   SET config = f.config || '{"unitField":"budget_unit","unitOptions":[{"value":"sqft","label":"Sq. ft."},{"value":"sqyd","label":"Sq. yd."},{"value":"total","label":"Total"}]}'::jsonb
 WHERE f.name = 'budget' AND f.module_id IN (SELECT id FROM ipy_module WHERE name = 'leads');

-- Property side: the Demand pair.
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS demand NUMERIC(16,2);
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS demand_unit TEXT;
UPDATE ipy_e_properties SET demand_unit = 'total' WHERE demand_unit IS NULL;

INSERT INTO ipy_field (module_id, block_id, name, label, uitype, storage, column_name, sequence, is_custom, config)
SELECT m.id, b.id, 'demand', 'Demand', 'currency', 'column', 'demand', 0, false,
       '{"currency":"INR","min":0,"unitField":"demand_unit","unitOptions":[{"value":"sqft","label":"Sq. ft."},{"value":"sqyd","label":"Sq. yd."},{"value":"total","label":"Total"}]}'::jsonb
  FROM ipy_module m
  JOIN ipy_block b ON b.module_id = m.id AND b.name = 'pricing'
 WHERE m.name = 'properties'
   AND NOT EXISTS (SELECT 1 FROM ipy_field f WHERE f.module_id = m.id AND f.name = 'demand');

INSERT INTO ipy_field (module_id, block_id, name, label, uitype, storage, column_name, sequence, is_custom, default_value, display_type, config)
SELECT m.id, b.id, 'demand_unit', 'Demand Unit', 'picklist', 'column', 'demand_unit', 1, false, '"total"', 'hidden',
       '{"picklist":"price_unit"}'::jsonb
  FROM ipy_module m
  JOIN ipy_block b ON b.module_id = m.id AND b.name = 'pricing'
 WHERE m.name = 'properties'
   AND NOT EXISTS (SELECT 1 FROM ipy_field f WHERE f.module_id = m.id AND f.name = 'demand_unit');

INSERT INTO ipy_field (module_id, block_id, name, label, uitype, storage, column_name, sequence, is_custom, default_value, display_type, config)
SELECT m.id, b.id, 'budget_unit', 'Budget Unit', 'picklist', 'column', 'budget_unit', 1, false, '"total"', 'hidden',
       '{"picklist":"price_unit"}'::jsonb
  FROM ipy_module m
  JOIN ipy_block b ON b.module_id = m.id AND b.name = 'requirement'
 WHERE m.name = 'leads'
   AND NOT EXISTS (SELECT 1 FROM ipy_field f WHERE f.module_id = m.id AND f.name = 'budget_unit');

-- Both new fields sit beside their number in the layout blocks that hold them.
-- Layout blocks key on `key` (the seed name), not `label`.
UPDATE ipy_layout l
   SET config = jsonb_set(config, '{blocks}', (
     SELECT jsonb_agg(
              CASE WHEN b->>'key' = 'requirement'
                     THEN jsonb_set(b, '{fields}',
                            (SELECT COALESCE(jsonb_agg(f), '[]'::jsonb)
                               FROM (
                                 SELECT f FROM jsonb_array_elements(b->'fields') f
                                  WHERE f #>> '{}' NOT IN ('budget', 'budget_unit', 'budget_band')
                                  UNION ALL
                                  SELECT '"budget"'::jsonb
                                  UNION ALL
                                  SELECT '"budget_unit"'::jsonb
                                  UNION ALL
                                  SELECT '"budget_band"'::jsonb WHERE (config->'blocks') IS NOT NULL AND EXISTS (
                                    SELECT 1 FROM ipy_field fl
                                     WHERE fl.module_id = l.module_id AND fl.name = 'budget_band')
                               ) fs)
                          )
                   WHEN b->>'key' = 'pricing'
                     THEN jsonb_set(b, '{fields}',
                            (SELECT COALESCE(jsonb_agg(f), '[]'::jsonb)
                               FROM (
                                 SELECT f FROM jsonb_array_elements(b->'fields') f
                                  WHERE f #>> '{}' NOT IN ('demand', 'demand_unit', 'base_price')
                                  UNION ALL
                                  SELECT '"demand"'::jsonb
                                  UNION ALL
                                  SELECT '"demand_unit"'::jsonb
                                  UNION ALL
                                  SELECT '"base_price"'::jsonb
                               ) fs)
                          )
                   ELSE b END)
       FROM jsonb_array_elements(config->'blocks') b
   ))
 WHERE l.type = 'detail'
   AND l.module_id IN (SELECT id FROM ipy_module WHERE name IN ('leads', 'properties'))
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(config->'blocks') b
                WHERE b->>'key' IN ('requirement', 'pricing'));
