-- The country code stops being a question.
--
-- Every lead this business will ever have is an Indian mobile, and the owner
-- asked for the field to go: "+91 only, forever". Keeping it as a stored field
-- cost a mandatory dropdown on every create form, a second thing to get wrong
-- on every import, and a column on every row that only ever held one value.
--
-- Nothing is lost by dropping it. The code was never part of the stored number
-- — `mobile` has always been ten bare digits — and `toInternational()` already
-- falls back to +91 when no code is supplied, which is now every call. What the
-- phone control shows in front of the box comes from the field's own
-- `codePrefix` setting instead, so an admin can still change it in one place
-- without a field, a dropdown or a deploy.

-- 1. The field itself, and the tombstone that stops db:seed rebuilding it.
INSERT INTO ipy_field_tombstone (module_name, field_name, storage, column_name, had_values)
SELECT 'leads', 'country_code', 'column', 'country_code',
       (SELECT COUNT(*) FROM ipy_e_leads WHERE country_code IS NOT NULL)
WHERE EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'ipy_e_leads' AND column_name = 'country_code')
ON CONFLICT (module_name, field_name) DO NOTHING;

DELETE FROM ipy_field f
 USING ipy_module m
 WHERE f.module_id = m.id AND m.name = 'leads' AND f.name = 'country_code';

ALTER TABLE ipy_e_leads DROP COLUMN IF EXISTS country_code;

-- 2. The dropdown behind it. '' tombstones the whole list, not one option.
INSERT INTO ipy_picklist_tombstone (picklist_name, value, had_records)
VALUES ('country_code', '', NULL)
ON CONFLICT (picklist_name, value) DO NOTHING;

DELETE FROM ipy_picklist WHERE name = 'country_code';

-- 3. Mobile keeps ten digits, and gains the prefix the control now renders.
--
-- Merged rather than replaced: an admin who has already edited this field's
-- validation or help text keeps every other key.
UPDATE ipy_field f
   SET config = (f.config - 'digitsFrom' - 'digitsMap' - 'countryCodes')
                || '{"digits":10,"codePrefix":"+91"}'::jsonb,
       updated_at = now()
  FROM ipy_module m
 WHERE f.module_id = m.id AND m.name = 'leads' AND f.uitype = 'phone'
   AND (f.config ? 'digitsFrom' OR f.config ? 'countryCodes' OR NOT (f.config ? 'codePrefix'));

-- 4. Anything that still names the field. A saved view whose columns list a
--    field that no longer exists renders a blank column rather than failing,
--    which is the kind of thing nobody reports and everybody works around.
UPDATE ipy_view
   SET columns = COALESCE((SELECT jsonb_agg(c) FROM jsonb_array_elements_text(columns) AS c
                            WHERE c <> 'country_code'), '[]'::jsonb)
 WHERE columns @> '["country_code"]'::jsonb;

UPDATE ipy_layout
   SET config = replace(config::text, '"country_code",', '')::jsonb
 WHERE config::text LIKE '%"country_code",%';

UPDATE ipy_layout
   SET config = replace(config::text, ',"country_code"', '')::jsonb
 WHERE config::text LIKE '%,"country_code"%';

UPDATE ipy_layout
   SET config = replace(config::text, '["country_code"]', '[]')::jsonb
 WHERE config::text LIKE '%["country_code"]%';

-- The other number on a lead gets the same prefix. Not WhatsApp Number: that
-- one stores the full dialable form on purpose, and painting a code in front of
-- a value that already carries one reads as "+91 +919811533636".
UPDATE ipy_field f
   SET config = f.config || '{"codePrefix":"+91"}'::jsonb, updated_at = now()
  FROM ipy_module m
 WHERE f.module_id = m.id AND m.name = 'leads'
   AND f.name = 'alternate_phone'
   AND NOT (f.config ? 'codePrefix');
