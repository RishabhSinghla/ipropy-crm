-- The Area and Budget/Demand masters become the list the CRM actually offers.
--
-- Until now there were two. Every area and currency field carried a frozen
-- copy of its options in `config.unitOptions`, written when the field was
-- seeded — Sq.ft. and Sq.yd., nothing else. `ipy_unit_master` held eight of
-- each and had its own admin screen. An admin who added Bigha or Marla edited
-- a table nothing read: the form went on offering two.
--
-- Migration 118 tagged the fields with `unitMaster` to close that, and the
-- seed undid it about an hour later — `config` is replaced wholesale for any
-- field an admin has not customised, so the tag never survived a cold start.
-- The template carries the tag now; this does the same for databases that
-- already exist, including the fields an admin *has* customised, whose config
-- the seed will never touch again.

-- 1. Point every amount field at the right master and drop the stale copy, so
--    `registry.syncUnitMasters` fills the options fresh on every read.
UPDATE ipy_field
   SET config = (config - 'unitOptions')
              || jsonb_build_object('unitMaster', CASE WHEN uitype = 'area' THEN 'area' ELSE 'budget_demand' END)
 WHERE uitype IN ('area', 'currency')
   AND config ? 'unitField';

-- 2. The companion picklists follow the master too.
--
--    The form reads the amount field's `unitOptions`, but the *unit* field is
--    an ordinary picklist, and list views, filters, reports and import all read
--    that. Leaving it at two values meant picking Bigha on a form stored a
--    value the Area Unit column could not display and no filter could match —
--    a value orphaned the moment it was chosen.
INSERT INTO ipy_picklist_value (picklist_id, value, label, sequence)
SELECT p.id, u.value, u.label, u.sequence
  FROM ipy_picklist p
  JOIN ipy_unit_master u
    ON (p.name = 'area_unit' AND u.kind = 'area')
    OR (p.name IN ('price_unit', 'demand_unit') AND u.kind = 'budget_demand')
 WHERE u.is_active
   AND NOT EXISTS (
     SELECT 1 FROM ipy_picklist_value v WHERE v.picklist_id = p.id AND v.value = u.value
   )
   -- An option somebody deliberately removed stays removed.
   AND NOT EXISTS (
     SELECT 1 FROM ipy_picklist_tombstone t WHERE t.picklist_name = p.name AND t.value = u.value
   );
