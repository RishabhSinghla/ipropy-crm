-- A unit held with no end date leaves the market and never comes back.
--
-- "Release expired blocks" runs hourly with the condition
-- `blocked_until older_than_n_days 0`. A blank date is never older than
-- anything, so a hold with no expiry is never released. The unit is not
-- Available, so it drops out of buyer matching, the first reply, lead scoring
-- and the public website, and nothing anywhere reports it.
--
-- Broadening the release job would be the wrong fix: it would free every blank
-- hold at the next tick, including one a rep set deliberately ten minutes ago.
--
-- Instead the date becomes required at the moment it matters. `is_mandatory`
-- cannot say this — it is required always or never, and always would block every
-- property that is not on hold, which is nearly all of them. `requiredWhen`
-- carries a condition in the same filter grammar the rest of the CRM uses, so an
-- admin can see and change it, and the same mechanism now serves any other
-- "required only when" rule: a reason on a Lost lead, a value on a Won one.

UPDATE ipy_field
   SET config = COALESCE(config, '{}'::jsonb) || '{
         "requiredWhen": {
           "logic": "AND",
           "conditions": [{ "field": "status", "operator": "in", "value": ["Held", "Blocked"] }]
         }
       }'::jsonb,
       updated_at = now()
 WHERE name = 'blocked_until'
   AND module_id IN (SELECT id FROM ipy_module WHERE name = 'properties')
   AND NOT (COALESCE(config, '{}'::jsonb) ? 'requiredWhen');

-- Anything already stuck in that state gets a week from now, so the existing
-- backlog drains through the normal release job rather than staying invisible.
UPDATE ipy_e_properties
   SET blocked_until = (now() + interval '7 days')::date
 WHERE status IN ('Held', 'Blocked')
   AND blocked_until IS NULL;

-- The All-inclusive Price is not all-inclusive.
--
-- The formula is base price plus the six charge fields. GST, stamp duty and
-- registration are not in it, and all three sit directly above the total on the
-- same form — Registration Charge is a plain rupee figure, so it is the one a
-- person is most likely to fill in and expect to see counted.
--
-- The label is what changes, not the formula. total_price is the advertised
-- price everywhere: the public website, the big number on every share link, the
-- Price line in the WhatsApp summary. Adding tax to it would raise every one of
-- those by about 11% overnight, and would silently narrow buyer matching, which
-- counts inventory at `total_price <= budget * 1.1`. It would also leave old
-- records on the old meaning until somebody edited them, with no way to tell
-- which meaning a row held.
--
-- Renaming costs nothing: no code compares against the label, and the one
-- buyer-facing surface that carries it drops it anyway.

UPDATE ipy_field
   SET label = 'Price with Charges',
       help_text = 'Base price plus floor rise, PLC, parking, club, maintenance deposit and other charges. Does not include GST, stamp duty or registration.',
       updated_at = now()
 WHERE name = 'total_price'
   AND module_id IN (SELECT id FROM ipy_module WHERE name = 'properties')
   AND label = 'All-inclusive Price';
