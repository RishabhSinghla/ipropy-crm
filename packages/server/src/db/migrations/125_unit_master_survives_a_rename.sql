-- Put back the unit list a rename took away.
--
-- `config.unitMaster` holds a *kind* — 'area' or 'budget_demand' — and the
-- rename sweep treated every string in `config` as a field name. So renaming
-- Area to Area / Size wrote `unitMaster: 'area_size'`, which matches no master,
-- and the field's Sq Ft / Sq Yd / Bigha list came back empty. Renaming Demand
-- to Base Price did the same to the Cr / Lac list. Both of those renames have
-- happened on production.
--
-- The rename itself no longer does this (core/metadata/fieldRename.ts captures
-- and restores the keys that are not field names). This repairs the databases
-- where it already happened: the kind is decided by the field's own type, which
-- is the only thing it was ever derived from.
UPDATE ipy_field
   SET config = jsonb_set(
         config, '{unitMaster}',
         to_jsonb(CASE WHEN uitype = 'area' THEN 'area' ELSE 'budget_demand' END))
 WHERE config ? 'unitMaster'
   AND uitype IN ('area', 'currency')
   AND config->>'unitMaster' NOT IN ('area', 'budget_demand');

-- An amount field that lost the tag altogether — its companion picklist is
-- still there, hidden, and offers whatever it was seeded with — gets it back
-- the same way. `unitField` is the evidence that it is one of these.
UPDATE ipy_field
   SET config = config || jsonb_build_object(
         'unitMaster', CASE WHEN uitype = 'area' THEN 'area' ELSE 'budget_demand' END)
 WHERE uitype IN ('area', 'currency')
   AND config ? 'unitField'
   AND NOT config ? 'unitMaster';
