-- A lead needs one way to reach them, not one particular way.
--
-- `mobile` was mandatory on its own, so an enquiry carrying only an email
-- address could not be saved at all. That is not a rare shape: NRI buyers,
-- people who fill a form from a desk, and anyone who would rather be emailed
-- first all arrive that way, and this business sells to exactly those people.
--
-- The damage was not the rejected leads. It is what a rep does when the form
-- refuses to save: type a number that gets past the validation. A fake mobile
-- is worse than a blank one, because a blank one is honest and a fake one is
-- indistinguishable from a real one forever afterwards. The strict rule
-- produced worse data than the loose rule would have.
--
-- The replacement is a rule about the pair, which no per-field flag can
-- express: at least one of Mobile or Email. Both empty is still a record nobody
-- can contact, and that is still refused.
--
-- It lives in ipy_module.settings rather than in TypeScript so it is one place,
-- reachable without a deploy, and so the same mechanism serves any other module
-- that ever needs "one of these two".

UPDATE ipy_module
   SET settings = COALESCE(settings, '{}'::jsonb)
                  || '{"requireOneOf": [["mobile", "email"]]}'::jsonb,
       updated_at = now()
 WHERE name = 'leads'
   AND NOT (COALESCE(settings, '{}'::jsonb) ? 'requireOneOf');

-- And drop the hard requirement the rule replaces. Guarded on the rule being
-- present, so this cannot leave the module with neither.
UPDATE ipy_field
   SET is_mandatory = false, updated_at = now()
 WHERE name = 'mobile'
   AND module_id IN (
     SELECT id FROM ipy_module
      WHERE name = 'leads' AND settings ? 'requireOneOf'
   );
