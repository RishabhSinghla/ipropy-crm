-- The property duplicate check was set to a number the system generates itself.
--
-- `duplicate_check_fields` on properties was `["property_code"]`. That is an
-- autonumber, and `prepareValues` stamps a fresh one on the way in *before* the
-- duplicate check runs — so the check searched for a value that had never been
-- stored, and could not match. Ever. The same floor entered twice under two
-- titles both went live, and the CRM reported no problem because it had asked a
-- question with only one possible answer.
--
-- This is the third thing found this week that looked like protection and gave
-- none: a rename guard naming a field that did not exist, a workflow filtering
-- on a deleted column, and now this.
--
-- The replacement is the identity a builder floor actually has: where it is,
-- which building, and which floor. `tower` and `unit_number` are deliberately
-- left out — not one live property fills either in, and a key containing a field
-- nobody fills is the same no-op wearing different clothes.
--
-- The fields combine rather than stand alone, which is the opposite of how the
-- check works for people. Two floors in one locality are not duplicates; the
-- same house number on the same floor is. That is `duplicateCheckMode = all`.

UPDATE ipy_module
   SET duplicate_check_fields = '["name", "locality", "floor"]'::jsonb,
       settings = COALESCE(settings, '{}'::jsonb) || '{"duplicateCheckMode": "all"}'::jsonb,
       updated_at = now()
 WHERE name = 'properties'
   AND duplicate_check_fields = '["property_code"]'::jsonb;
