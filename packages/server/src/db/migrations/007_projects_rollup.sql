-- Rollup fields on projects need a real column for the new total_inventory
-- aggregate (available_units / booked_units already have columns). Values are
-- computed on read by core/entity/rollups.ts; the stored value is a fallback.
ALTER TABLE ipy_e_projects ADD COLUMN IF NOT EXISTS total_inventory INT NOT NULL DEFAULT 0;
