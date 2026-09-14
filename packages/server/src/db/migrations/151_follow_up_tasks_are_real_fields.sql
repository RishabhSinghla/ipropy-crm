-- A follow-up is a task on both sides of the CRM.  Some long-lived databases
-- received the property detail UI before the matching payload column and
-- field metadata, leaving a date control that could not be saved.
--
-- Put the task date in one durable DATE column for each module.  Existing
-- lead data is left untouched; the property clause also recovers dates that
-- were temporarily stored in custom_fields by the earlier UI.

ALTER TABLE ipy_e_leads
  ALTER COLUMN next_followup_at TYPE DATE USING next_followup_at::date;

ALTER TABLE ipy_e_properties
  ADD COLUMN IF NOT EXISTS next_followup_at DATE;

UPDATE ipy_e_properties
   SET next_followup_at = substring(custom_fields ->> 'next_followup_at' FROM '^\\d{4}-\\d{2}-\\d{2}')::date
 WHERE next_followup_at IS NULL
   AND custom_fields ? 'next_followup_at'
   AND (custom_fields ->> 'next_followup_at') ~ '^\\d{4}-\\d{2}-\\d{2}';

CREATE INDEX IF NOT EXISTS idx_property_followup
  ON ipy_e_properties(next_followup_at)
  WHERE next_followup_at IS NOT NULL;

-- Correct legacy metadata in place without overwriting the administrator's
-- label, position, layout or visibility choices.
UPDATE ipy_field
   SET uitype = 'date', storage = 'column', column_name = 'next_followup_at', updated_at = now()
 WHERE column_name = 'next_followup_at'
   AND module_id IN (SELECT id FROM ipy_module WHERE name IN ('leads', 'properties'));

INSERT INTO ipy_block (module_id, name, label, sequence, columns)
SELECT id, 'follow_up', 'Follow Up', 90, 2
  FROM ipy_module
 WHERE name = 'properties'
ON CONFLICT (module_id, name) DO UPDATE SET label = EXCLUDED.label;

INSERT INTO ipy_field
  (module_id, block_id, name, label, uitype, storage, column_name, sequence, is_custom, quick_create)
SELECT m.id, b.id, 'next_followup_at', 'Next Follow-up', 'date', 'column', 'next_followup_at', 0, false, false
  FROM ipy_module m
  JOIN ipy_block b ON b.module_id = m.id AND b.name = 'follow_up'
 WHERE m.name = 'properties'
   AND NOT EXISTS (
     SELECT 1 FROM ipy_field f WHERE f.module_id = m.id AND f.name = 'next_followup_at'
   );
