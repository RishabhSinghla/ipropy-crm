-- Casts that answer NULL instead of raising, and the area pair loses carpet_area.
--
-- Two unrelated-looking needs, one root: this CRM lets an administrator change
-- a field's type and delete a field outright, and both of those turn a value
-- that was valid yesterday into text Postgres cannot cast today. A cast that
-- raises inside a SELECT does not spoil one value — it fails the statement,
-- which is how buyer matching came to answer "no matches" for every lead in
-- the business.
--
-- These are IMMUTABLE and STRICT so they can be used in indexes and generated
-- columns later, and each swallows only the cast error it exists for.

CREATE OR REPLACE FUNCTION ipy_try_numeric(t text) RETURNS numeric
  LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
BEGIN RETURN t::numeric; EXCEPTION WHEN others THEN RETURN NULL; END $$;

CREATE OR REPLACE FUNCTION ipy_try_int(t text) RETURNS integer
  LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
BEGIN RETURN floor(t::numeric)::integer; EXCEPTION WHEN others THEN RETURN NULL; END $$;

CREATE OR REPLACE FUNCTION ipy_try_date(t text) RETURNS date
  LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
BEGIN RETURN t::date; EXCEPTION WHEN others THEN RETURN NULL; END $$;

CREATE OR REPLACE FUNCTION ipy_try_timestamptz(t text) RETURNS timestamptz
  LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
BEGIN RETURN t::timestamptz; EXCEPTION WHEN others THEN RETURN NULL; END $$;

CREATE OR REPLACE FUNCTION ipy_try_uuid(t text) RETURNS uuid
  LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
BEGIN RETURN t::uuid; EXCEPTION WHEN others THEN RETURN NULL; END $$;

-- Deliberately wider than `::boolean`: an imported spreadsheet says Yes/Y/1,
-- and a column that only understands 'true' turns all three into an error.
CREATE OR REPLACE FUNCTION ipy_try_bool(t text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE lower(btrim(t))
           WHEN 'true' THEN true  WHEN 't' THEN true  WHEN 'yes' THEN true
           WHEN 'y'    THEN true  WHEN '1' THEN true  WHEN 'on'  THEN true
           WHEN 'false' THEN false WHEN 'f' THEN false WHEN 'no' THEN false
           WHEN 'n'    THEN false WHEN '0' THEN false WHEN 'off' THEN false
         END $$;

-- The matching pair that named a field about to be deleted.
--
-- Admin → Matching Setup stores its pairs as a setting, so the default in
-- code does not reach a database that already has one. `carpet_area` is being
-- removed from Properties (113), and a pair naming a field that is not there
-- compares nothing — silently, because the engine reads it as "no value".
UPDATE ipy_setting
   SET value = replace(value::text, '"propertyField":"carpet_area"', '"propertyField":"area"')::jsonb
 WHERE key = 'matching.field_map'
   AND value::text LIKE '%"propertyField":"carpet_area"%';
