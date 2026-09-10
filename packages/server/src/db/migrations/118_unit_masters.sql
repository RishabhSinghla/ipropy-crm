-- Reusable masters for every present and future area/rate field. The numeric
-- amount remains on the record; the selected unit is a separate companion
-- field so filtering, imports and exports retain both facts.
CREATE TABLE IF NOT EXISTS ipy_unit_master (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        TEXT NOT NULL CHECK (kind IN ('area','budget_demand')),
  value       TEXT NOT NULL,
  label       TEXT NOT NULL,
  factor_sqft NUMERIC,
  sequence    INT NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  is_default  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, value)
);
CREATE INDEX IF NOT EXISTS idx_unit_master_kind ON ipy_unit_master(kind, sequence);

INSERT INTO ipy_unit_master (kind, value, label, factor_sqft, sequence, is_default) VALUES
  ('area','sqft',    'Sq. Ft.', 1,       10, true),
  ('area','sqyd',    'Sq. Yds.', 9,      20, false),
  ('area','sqm',     'Sq. Mtr.', 10.7639,30, false),
  ('area','acre',    'Acre', 43560,     40, false),
  ('area','bigha',   'Bigha', NULL,     50, false),
  ('area','marla',   'Marla', 272.25,   60, false),
  ('area','kanal',   'Kanal', 5445,     70, false),
  ('area','hectare', 'Hectare', 107639.104,80, false),
  ('budget_demand','total',    'Total Budget / Demand', NULL, 10, true),
  ('budget_demand','sqft',     'Per Sq. Ft.', NULL, 20, false),
  ('budget_demand','sqyd',     'Per Sq. Yd.', NULL, 30, false),
  ('budget_demand','sqm',      'Per Sq. Mtr.', NULL, 40, false),
  ('budget_demand','acre',     'Per Acre', NULL, 50, false),
  ('budget_demand','bigha',    'Per Bigha', NULL, 60, false),
  ('budget_demand','marla',    'Per Marla', NULL, 70, false),
  ('budget_demand','kanal',    'Per Kanal', NULL, 80, false)
ON CONFLICT (kind, value) DO NOTHING;

-- Existing fields switch from copied option arrays to a master reference.
UPDATE ipy_field
   SET config = config || jsonb_build_object('unitMaster', CASE WHEN uitype = 'area' THEN 'area' ELSE 'budget_demand' END)
 WHERE uitype IN ('area','currency') AND config ? 'unitField';
