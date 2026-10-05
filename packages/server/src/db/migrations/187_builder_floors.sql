-- Builder Floors — the module behind the owner's own spreadsheet.
--
-- 5 October 2026, with "Builder Floors 2026 - Single.pdf": 130 floors across 60
-- buildings, one row per building with four price columns (1st/2nd/3rd/4th).
--
-- **One record is one FLOOR, not one building**, and that decision is the whole
-- design. Everything he asked for is per floor: filter floor-wise, a sold unit
-- leaving the list, a brochure sent to a buyer, room sizes from that floor's
-- plan. A record per building cannot answer "show me every 2nd floor under 3
-- crore" in the filter grammar at all — the price would be in one of four
-- columns and the grammar has no way to say "any of these four".
--
-- **Why it is not the Properties module**, which already holds units: a
-- property's identity there is the owner's mobile and that column is UNIQUE. In
-- his sheet Khagender Chauhan's one number owns five buildings, which is twenty
-- floors — nineteen of them would be refused on insert. Changing that uniqueness
-- is a live production rule and not something to break quietly for a new feature.
--
-- The building's own facts (plot number, owner, plot size, facing, road, stage)
-- sit on each floor and `building_code` groups them. That repeats a handful of
-- values across up to four rows, which is a real cost and the smaller one: the
-- alternative is a second module every rep must fill in before they can record a
-- floor, on a list of sixty buildings he already keeps in a spreadsheet.
--
-- **This table is deliberately almost empty.** `upsertModule` in the seed adds a
-- column for every `storage: 'column'` field it defines (`ensureColumn`, ADD
-- COLUMN IF NOT EXISTS), so listing the fields here as well would be two places
-- to keep in step and the first drift would be silent. The module itself lives in
-- `db/seed/templates/realEstate.ts` — which is also the lesson migration 175 left
-- behind: a migration cannot create a module the seed does not know about, or the
-- module is absent on every fresh database.
-- **The five columns below are declared here and nowhere else in this file**,
-- and only because an index needs them to exist. Everything else the module has
-- — and there are forty more — is added by the seed.
--
-- The reason they cannot be left to the seed is the rule this repo already
-- wrote down: **migrations run before the seed.** The first version of this
-- migration created each index behind an `IF EXISTS` check on its column, which
-- on a fresh database is every check failing and **no index created, silently** —
-- caught here by looking, not by any test. `ensureColumn` returns early when a
-- column is already present, so declaring these costs nothing and drifts from
-- nothing: the types are exactly what `COLUMN_TYPES` produces for their uitypes
-- (picklist and string → TEXT, currency → NUMERIC).
CREATE TABLE IF NOT EXISTS ipy_e_builder_floors (
  record_id     UUID PRIMARY KEY REFERENCES ipy_record(id) ON DELETE CASCADE,
  -- The plot number. Every floor of one building shares it.
  building_code TEXT,
  floor         TEXT,
  accommodation TEXT,
  floor_status  TEXT,
  demand        NUMERIC,
  -- Admin-created fields live here, as on every payload table: no DDL at runtime.
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- The four questions this module exists to answer quickly: which building,
-- what is still on the market, what it costs, and floor-plus-accommodation
-- together — which is "every 2nd floor 4 BHK", the query his spreadsheet
-- cannot answer at all.
CREATE INDEX IF NOT EXISTS idx_bf_building ON ipy_e_builder_floors(building_code);
CREATE INDEX IF NOT EXISTS idx_bf_status   ON ipy_e_builder_floors(floor_status);
CREATE INDEX IF NOT EXISTS idx_bf_demand   ON ipy_e_builder_floors(demand);
CREATE INDEX IF NOT EXISTS idx_bf_floor    ON ipy_e_builder_floors(floor, accommodation);
