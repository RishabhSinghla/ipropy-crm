-- ===========================================================================
-- iPropy CRM — 026: one name field, no salutation, an explicit country code
--
-- Three form-level simplifications, all of which have to survive contact with
-- data that already exists.
--
-- The rule throughout: **add and backfill, never drop**. `first_name` and
-- `last_name` keep their columns and their values; they are only retired from
-- the metadata so nothing renders them. If the merge turns out wrong for one
-- record in ten thousand, the original halves are still sitting there.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Full name
-- ---------------------------------------------------------------------------

ALTER TABLE ipy_e_leads ADD COLUMN IF NOT EXISTS full_name TEXT;

-- Backfill. `concat_ws` skips nulls rather than producing "Rishabh " or
-- " Singhla", and the trim catches rows where both halves were blank.
UPDATE ipy_e_leads
SET full_name = NULLIF(trim(concat_ws(' ', NULLIF(trim(first_name), ''), NULLIF(trim(last_name), ''))), '')
WHERE full_name IS NULL;

-- Anything still empty had no name at all. The record still needs a label, so
-- fall back to the mobile number — an unnamed enquiry from a phone number is a
-- real thing on a property desk, and "Lead" as a label helps nobody.
UPDATE ipy_e_leads
SET full_name = COALESCE(NULLIF(trim(mobile), ''), 'Unnamed enquiry')
WHERE full_name IS NULL OR trim(full_name) = '';

ALTER TABLE ipy_e_leads ALTER COLUMN full_name SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_full_name ON ipy_e_leads (lower(full_name));

-- ---------------------------------------------------------------------------
-- Country code
--
-- Split out rather than baked into the number. `toE164` defaulted everything to
-- +91, which is right for almost every enquiry and silently wrong for the NRI
-- buyers who are a real part of this market — and a number stored with the
-- wrong country code fails to match on WhatsApp and on the call log, so the
-- lead looks like a stranger every time they get in touch.
-- ---------------------------------------------------------------------------

ALTER TABLE ipy_e_leads ADD COLUMN IF NOT EXISTS country_code TEXT NOT NULL DEFAULT '+91';

-- Split stored numbers into code + national part.
--
-- **Length decides, not the prefix.** `9112345678` is a perfectly ordinary
-- ten-digit Indian mobile that happens to begin "91"; a prefix-matching rule
-- strips it to `12345678` and silently destroys the number. So a country code
-- is only recognised when removing it leaves a plausible national number
-- behind — which for a bare ten-digit number is never.
--
-- Longest prefix first so +971 is not read as +97, and the codes are the Gulf,
-- Singapore, Australia, UK and North America: where NRI buyers for Faridabad
-- builder floors actually call from.
WITH digits AS (
  SELECT
    record_id,
    regexp_replace(COALESCE(mobile, ''), '\D', '', 'g') AS d,
    -- The `+` is the only reliable evidence that a country code is present.
    -- Without it, `6591234567` is an Indian mobile and `+6591234567` is a
    -- Singapore one, and nothing about the digits can tell them apart.
    COALESCE(mobile, '') LIKE '+%' AS explicit
  FROM ipy_e_leads
),
split AS (
  SELECT
    record_id,
    d,
    CASE
      -- A bare ten-digit number is national. Assuming otherwise is what
      -- turns `9112345678` into `12345678`.
      WHEN NOT explicit AND length(d) <= 10 THEN NULL
      WHEN d LIKE '971%' AND length(d) - 3 BETWEEN 8 AND 9  THEN '971'
      WHEN d LIKE '966%' AND length(d) - 3 BETWEEN 8 AND 9  THEN '966'
      WHEN d LIKE '974%' AND length(d) - 3 BETWEEN 7 AND 8  THEN '974'
      WHEN d LIKE '968%' AND length(d) - 3 BETWEEN 7 AND 8  THEN '968'
      WHEN d LIKE '965%' AND length(d) - 3 BETWEEN 7 AND 8  THEN '965'
      WHEN d LIKE '973%' AND length(d) - 3 BETWEEN 7 AND 8  THEN '973'
      WHEN d LIKE '91%'  AND length(d) - 2 = 10             THEN '91'
      WHEN d LIKE '65%'  AND length(d) - 2 = 8              THEN '65'
      WHEN d LIKE '61%'  AND length(d) - 2 = 9              THEN '61'
      WHEN d LIKE '44%'  AND length(d) - 2 = 10             THEN '44'
      WHEN d LIKE '1%'   AND length(d) - 1 = 10             THEN '1'
      ELSE NULL
    END AS code
  FROM digits
)
UPDATE ipy_e_leads l
SET country_code = COALESCE('+' || s.code, '+91'),
    -- Leading zeros are a trunk prefix, not part of the number: an imported
    -- "09812345678" is the same person as "9812345678".
    mobile = CASE
      WHEN s.code IS NOT NULL THEN substr(s.d, length(s.code) + 1)
      ELSE regexp_replace(s.d, '^0+', '')
    END
FROM split s
WHERE l.record_id = s.record_id AND s.d <> '';

-- ---------------------------------------------------------------------------
-- Metadata
--
-- The columns above are only half the job; the form renders from `ipy_field`,
-- so the old fields have to be retired there and the new ones described.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  leads_id UUID;
  basic_block UUID;
BEGIN
  SELECT id INTO leads_id FROM ipy_module WHERE name = 'leads';
  IF leads_id IS NULL THEN RETURN; END IF;

  SELECT id INTO basic_block FROM ipy_block
   WHERE module_id = leads_id AND name = 'lead_information' LIMIT 1;

  -- Retired, not deleted: is_active = false leaves the values readable by
  -- anything that still asks for them while removing them from every form.
  UPDATE ipy_field SET is_active = false, is_mandatory = false
   WHERE module_id = leads_id AND name IN ('salutation', 'first_name', 'last_name');

  INSERT INTO ipy_field
    (module_id, block_id, name, label, uitype, storage, column_name, sequence,
     is_mandatory, quick_create, searchable, max_length, help_text)
  VALUES
    (leads_id, basic_block, 'full_name', 'Full Name', 'text', 'column', 'full_name', 2,
     true, true, true, 120, NULL)
  ON CONFLICT (module_id, name) DO UPDATE
    SET is_active = true, is_mandatory = true, quick_create = true,
        searchable = true, max_length = 120, label = 'Full Name', sequence = 2;

  INSERT INTO ipy_field
    (module_id, block_id, name, label, uitype, storage, column_name, sequence,
     is_mandatory, quick_create, searchable, default_value, config, help_text)
  VALUES
    (leads_id, basic_block, 'country_code', 'Country', 'picklist', 'column', 'country_code', 3,
     true, true, false, '"+91"'::jsonb, '{"picklist":"country_code"}'::jsonb, NULL)
  ON CONFLICT (module_id, name) DO UPDATE
    SET is_active = true, label = 'Country', sequence = 3,
        config = '{"picklist":"country_code"}'::jsonb;

  -- Ten digits, enforced at the field so every form and the API agree.
  UPDATE ipy_field
     SET max_length = 10, help_text = '10 digits, without the country code', sequence = 4
   WHERE module_id = leads_id AND name = 'mobile';

  -- The label is built from `label_fields`; leaving first/last here would
  -- produce blank labels the moment those fields stop being written.
  UPDATE ipy_module SET label_fields = '["full_name"]'::jsonb WHERE id = leads_id;
END $$;

-- Rebuild every lead's display label from the new field.
UPDATE ipy_record r
SET label = l.full_name
FROM ipy_e_leads l
WHERE l.record_id = r.id AND r.module_name = 'leads' AND l.full_name IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Country picklist
-- ---------------------------------------------------------------------------

INSERT INTO ipy_picklist (name, label, is_system, is_global)
VALUES ('country_code', 'Country Code', true, true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO ipy_picklist_value (picklist_id, value, label, sequence, is_default)
SELECT p.id, v.value, v.label, v.sequence, v.is_default
FROM ipy_picklist p,
  (VALUES
    ('+91',  'India  +91',            10, true),
    ('+971', 'UAE  +971',             20, false),
    ('+966', 'Saudi Arabia  +966',    30, false),
    ('+974', 'Qatar  +974',           40, false),
    ('+968', 'Oman  +968',            50, false),
    ('+965', 'Kuwait  +965',          60, false),
    ('+973', 'Bahrain  +973',         70, false),
    ('+65',  'Singapore  +65',        80, false),
    ('+61',  'Australia  +61',        90, false),
    ('+44',  'United Kingdom  +44',  100, false),
    ('+1',   'USA / Canada  +1',     110, false)
  ) AS v(value, label, sequence, is_default)
WHERE p.name = 'country_code'
ON CONFLICT (picklist_id, value) DO NOTHING;
