-- Contact Type gets a default, because without one no automated lead can exist.
--
-- Every website enquiry was being rejected. The form answered
-- "Thanks — our team will call you shortly" and created nothing; the only trace
-- was a row in `ipy_lead_inbox` marked failed, with the reason
-- **"Contact Type is required"**, in a table nobody looks at.
--
-- `contact_type` is mandatory and not one of its nine options was marked as the
-- default, so nothing that creates a lead without explicitly choosing one could
-- succeed. That is every automated source there is: the website form, Facebook,
-- Google, the property portals, inbound email.
--
-- The fix belongs here rather than in the capture code. Putting `'Buyer'` in
-- TypeScript would be a business decision hidden in a file the owner cannot
-- open, and it would need repeating for each of the five sources. A default on
-- the option is one place, it is what defaults are for, and an admin can change
-- it in Admin → Dropdowns without anybody deploying.
--
-- Buyer is the right default for an inbound property enquiry, and it is a
-- starting point rather than a verdict — a rep changes it the moment they learn
-- the person is selling.

UPDATE ipy_picklist_value
   SET is_default = true
 WHERE value = 'Buyer'
   AND picklist_id IN (SELECT id FROM ipy_picklist WHERE name = 'contact_type')
   AND NOT EXISTS (
     SELECT 1 FROM ipy_picklist_value v2
      WHERE v2.picklist_id = ipy_picklist_value.picklist_id AND v2.is_default
   );

-- And on the field, which is what a programmatic create reads. The picklist
-- default drives the form; this drives everything that never opens one.
UPDATE ipy_field
   SET default_value = '"Buyer"'::jsonb
 WHERE name = 'contact_type'
   AND module_id IN (SELECT id FROM ipy_module WHERE name = 'leads')
   AND (default_value IS NULL OR default_value::text IN ('null', '""'));
