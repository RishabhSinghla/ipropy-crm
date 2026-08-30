-- A property reaches the public website only when somebody says so.
--
-- `publishClause` in `api/routes/public.ts` read
-- `publish_to_web IS NULL OR = 'true'`, and the key is unset on every newly
-- created record until somebody explicitly saves that field. So a property went
-- live the moment it was created — before it had photographs, a price, or a
-- verified address.
--
-- That is not hypothetical. Both properties on the public site right now show
-- "Price on request" because they have no price, and they are visible because
-- nobody ever chose to publish them.
--
-- This is the one blueprint rule worth taking straight away: publishing defaults
-- to off, and reaching the website is a decision somebody makes.
--
-- **Backfill before the behaviour changes.** Anything relying on the old
-- default gets an explicit `true` written onto it here, so nothing that is live
-- today disappears when the new clause ships. Turning something off is a
-- decision for the owner, not a side effect of a migration.

UPDATE ipy_e_properties
   SET custom_fields = jsonb_set(
         COALESCE(custom_fields, '{}'::jsonb), '{publish_to_web}', 'true'::jsonb)
 WHERE custom_fields->>'publish_to_web' IS NULL;

-- New records start hidden. `default_value` is what the create form seeds and
-- what `065_new_record_defaults` reads, so this is the half an admin sees.
UPDATE ipy_field
   SET default_value = 'false',
       help_text = 'Off until you turn it on. A property only appears on the public website once this '
           || 'is on and its status is one of the public ones.'
 WHERE name = 'publish_to_web'
   AND module_id IN (SELECT id FROM ipy_module WHERE name = 'properties');
