-- ===========================================================================
-- iPropy CRM — 006: remove the dead converted_contact_id column
--
-- After the Contacts→Leads merge (004), a converted lead IS the contact, so
-- this column was nulled and is never written again. The physical column and
-- its field metadata are leftovers from before the merge — nothing reads them.
--
-- Verified before writing: column is all-null; no index, no profile field
-- perms, no view/workflow/dashboard/report references to the field name.
-- Safe to run on a fresh database and idempotent. The seed never recreates the
-- field because db/seed/modules.ts no longer defines it.
-- ===========================================================================

-- 1. Drop the field metadata first — it is what the app actually reads.
DELETE FROM ipy_field
WHERE name = 'converted_contact_id'
  AND module_id = (SELECT id FROM ipy_module WHERE name = 'leads');

-- 2. Drop the physical column; its FK to ipy_record goes with it.
ALTER TABLE ipy_e_leads DROP COLUMN IF EXISTS converted_contact_id;
