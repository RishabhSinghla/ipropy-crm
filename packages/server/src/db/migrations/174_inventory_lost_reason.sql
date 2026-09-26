-- Inventory can close just as a lead can.  The field is intentionally the
-- same picklist as Leads so reports, filters and the Loss Rule have one
-- vocabulary; the record value remains on the property's own SQL row.

ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS lost_reason TEXT;

INSERT INTO ipy_field (
  module_id, block_id, name, label, uitype, storage, column_name, sequence,
  is_custom, is_active, is_mandatory, quick_create, mass_editable, searchable,
  display_type, config
)
SELECT
  m.id, b.id, 'lost_reason', 'Lost Reason', 'picklist', 'column', 'lost_reason', 55,
  false, true, false, false, true, true,
  'default', '{"picklist":"lost_reason"}'::jsonb
FROM ipy_module m
JOIN ipy_block b ON b.module_id = m.id AND b.name = 'property_information'
WHERE m.name = 'properties'
  AND NOT EXISTS (
    SELECT 1 FROM ipy_field field WHERE field.module_id = m.id AND field.name = 'lost_reason'
  );
