-- ===========================================================================
-- iPropy CRM — 027: correct the Full Name uitype
--
-- 026 created `full_name` as uitype `text`, which is not a registered uitype —
-- the vocabulary calls a single-line text field `string` (`text` exists in the
-- union type but has no entry in the UITYPE registry, so the renderer would
-- have fallen through to its default and the field would not have edited
-- properly).
--
-- Fixed forward rather than by re-running 026: that migration's phone split
-- reads the `+` prefix to decide whether a country code is present, and by now
-- the prefix has already been moved into `country_code`. Running it a second
-- time would see bare national numbers, find no `+`, and reset every non-Indian
-- lead to +91 — silently undoing the part that mattered most.
-- ===========================================================================

UPDATE ipy_field
SET uitype = 'string'
WHERE name = 'full_name'
  AND uitype = 'text'
  AND module_id = (SELECT id FROM ipy_module WHERE name = 'leads');
