-- One mobile number, one record, across Leads, Inventory and Associates.
--
-- Migration 190 put Leads and Inventory in the shared-number group, but the
-- Associates module (migration 175) was created before 190 ran, so on the live
-- database it never joined. A fresh install gets the group from the seed
-- template; this brings the deployed database in line with it.
--
-- Existing duplicates stay intact: the write engine only blocks NEW numbers
-- (the 85 existing groups are for the administrator's merge tool). Lead
-- capture already links an enquiry for a known number to the existing contact
-- instead of failing, and the dealer import counts it as "already known".
UPDATE ipy_module
   SET settings = settings || '{"mobileIdentityGroup":"crm-contact-mobile"}'::jsonb
 WHERE name = 'associates';
