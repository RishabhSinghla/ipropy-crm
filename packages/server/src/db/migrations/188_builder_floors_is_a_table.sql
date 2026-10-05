-- Builder Floors, rebuilt to the owner's own table — 5 October 2026.
--
-- The first cut made one record per *floor*. He corrected it the same day, with
-- a screenshot of the lead's Matching Inventory table: one record is one
-- **house**, with a price column per floor, which is the shape his spreadsheet
-- has always had. "Every 2nd floor under 3 crore" is a filter on
-- `second_floor_price`; "any floor under 3 crore" is an OR of five conditions,
-- which the filter grammar has had all along.
--
-- **Tombstones, not DROP COLUMN**, and that is the whole of this migration.
-- Removing a field from the seed template does not delete it: `upsertModule`
-- rebuilds every module on each run and `docker-entrypoint.sh` re-seeds on every
-- cold start, so a field taken out of the file comes straight back on the next
-- restart — the trap migration 032 exists for. `ipy_field_tombstone` is what
-- makes the removal durable.
--
-- The columns themselves stay. Nothing in this repo drops a column that might
-- hold somebody's data, and these cost nothing: `SELECT r.*, p.*` ignores a
-- column no field points at.
INSERT INTO ipy_field_tombstone (module_name, field_name, column_name, storage)
VALUES
  -- Became `locality` + `house_no`, which is also the new duplicate key.
  ('builder_floors', 'building_code', 'building_code', 'column'),
  -- A floor is a price column now, not a row of its own.
  ('builder_floors', 'floor',         'floor',         'column'),
  -- Renamed to his words: Builder's Name and Mobile Number.
  ('builder_floors', 'owner_name',    'owner_name',    'column'),
  ('builder_floors', 'owner_mobile',  'owner_mobile',  'column'),
  -- Became `size` / `size_unit`, the column his sheet calls Size.
  ('builder_floors', 'plot_size',      'plot_size',      'column'),
  ('builder_floors', 'plot_size_unit', 'plot_size_unit', 'column'),
  -- One asking price became five, one per floor.
  ('builder_floors', 'demand',        'demand',        'column'),
  ('builder_floors', 'demand_unit',   'demand_unit',   'column'),
  ('builder_floors', 'rate_per_sqyd', 'rate_per_sqyd', 'column')
ON CONFLICT DO NOTHING;

-- **And the rows have to go too.** A tombstone only stops `upsertModule`
-- *re-creating* a field; it does nothing to one already in `ipy_field`. Checked
-- rather than assumed: after the insert above, all nine were still on the module
-- and still on the form. So the tombstone keeps them away and this clears the
-- ones already there — both halves, or the module keeps a second Mobile, a
-- second Size and an Asking Price beside the five floor prices.
--
-- Safe to delete rather than deactivate because this module is four hours old
-- and its fields hold nothing: `seedDefaultLayouts` and `pruneFieldRefs` run
-- straight after and clear any layout or saved view that named them.
DELETE FROM ipy_field
 WHERE module_id = (SELECT id FROM ipy_module WHERE name = 'builder_floors')
   AND name IN (
     'building_code', 'floor', 'owner_name', 'owner_mobile',
     'plot_size', 'plot_size_unit', 'demand', 'demand_unit', 'rate_per_sqyd'
   );

-- The indexes follow the new identity. Migration 187's are on columns no field
-- points at any more, so they cost writes and answer nothing.
DROP INDEX IF EXISTS idx_bf_building;
DROP INDEX IF EXISTS idx_bf_floor;
DROP INDEX IF EXISTS idx_bf_demand;

-- Declared here as well as in the seed for the reason 187 learned the hard way:
-- **migrations run before the seed**, so an index guarded on a column the seed
-- has not added yet is an index silently never created. `ensureColumn` returns
-- early when a column already exists, so declaring these drifts from nothing —
-- the types are what `COLUMN_TYPES` produces for their uitypes.
ALTER TABLE ipy_e_builder_floors
  ADD COLUMN IF NOT EXISTS locality           TEXT,
  ADD COLUMN IF NOT EXISTS house_no           TEXT,
  ADD COLUMN IF NOT EXISTS first_floor_price  NUMERIC,
  ADD COLUMN IF NOT EXISTS second_floor_price NUMERIC,
  ADD COLUMN IF NOT EXISTS third_floor_price  NUMERIC,
  ADD COLUMN IF NOT EXISTS fourth_floor_price NUMERIC,
  ADD COLUMN IF NOT EXISTS top_floor_price    NUMERIC;

-- The identity, and the question the table exists to answer: every house in one
-- locality, which is what the middle pane lists.
CREATE INDEX IF NOT EXISTS idx_bf_locality ON ipy_e_builder_floors(locality, house_no);
CREATE INDEX IF NOT EXISTS idx_bf_prices
  ON ipy_e_builder_floors(first_floor_price, second_floor_price, third_floor_price);
