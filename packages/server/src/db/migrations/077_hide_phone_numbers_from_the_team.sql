-- Hide customer phone numbers from everyone except an admin.
--
-- The oldest risk in this industry: a rep leaves and the customer list leaves
-- with them. A CRM that prints every mobile on a list view can be copied in an
-- afternoon, and nothing about that copy is detectable afterwards.
--
-- On, and everybody who is not an admin sees `98xxxxxx56` — enough to recognise
-- a number they already know, useless for building a list. The masking happens
-- on the server, so the real number never reaches the browser; doing it in the
-- interface would leave it one devtools tab away from the person it is hidden
-- from.
--
-- They can still ring the customer. `GET /api/records/:module/:id/phone/:field`
-- hands back one number, for one record, and writes an audit row every time. So
-- forty calls a day leaves forty rows, and quietly harvesting a thousand numbers
-- leaves a thousand rows with a name against them.
--
-- Off by default. Switching this on is a decision about trusting your own team
-- and it should be taken deliberately, not inherited from a migration.

INSERT INTO ipy_setting (key, value, category, label, description) VALUES
  ('privacy.mask_phone_numbers', 'false'::jsonb, 'general',
   'Hide customer phone numbers from your team',
   'On, and anyone who is not an administrator sees a mobile as 98xxxxxx56 rather than the '
   || 'full number — on lists, on the record, and in exports. They can still call: tapping the '
   || 'number asks the CRM for it, one at a time, and every one of those is written to the audit '
   || 'log with their name on it. Turn this on if you want your customer list to stay yours when '
   || 'somebody leaves.')
ON CONFLICT (key) DO NOTHING;
