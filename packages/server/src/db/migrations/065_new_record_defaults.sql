-- What a new record starts as.
--
-- Both of these were declared in the seed and one of them never reached the
-- database: seeding options is create-only on purpose (an admin's renames and
-- re-colours must survive a cold start), so a default added to the template
-- after the option already existed changes nothing. Lifecycle Stage got its
-- "Lead" because it was seeded that way from the start; Lead Status never got
-- its "New", which is why a new lead opened with an empty Pipeline Status that
-- somebody had to fill in by hand every single time.
--
-- Written only where the dropdown has no default at all, so an admin who has
-- already starred a different option keeps their choice.
UPDATE ipy_picklist_value v
   SET is_default = true
  FROM ipy_picklist p
 WHERE v.picklist_id = p.id
   AND p.name = 'lead_status'
   AND v.value = 'New'
   AND NOT EXISTS (
     SELECT 1 FROM ipy_picklist_value d
      WHERE d.picklist_id = p.id AND d.is_default
   );

UPDATE ipy_picklist_value v
   SET is_default = true
  FROM ipy_picklist p
 WHERE v.picklist_id = p.id
   AND p.name = 'lifecycle_stage'
   AND v.value = 'Lead'
   AND NOT EXISTS (
     SELECT 1 FROM ipy_picklist_value d
      WHERE d.picklist_id = p.id AND d.is_default
   );
