-- A target for how complete a record is expected to be.
--
-- 4 October 2026, the owner: "i am pushing my team/agents that, they are fill
-- the form fields maximum … but alls are slacker … can you make an option for
-- that they are bound to filled maximum or all the fields in leads/inventory
-- module, or you can pushing hem time to time from crm/system."
--
-- Seeded 0, which means off. Nothing nags anybody until an administrator sets a
-- number in Admin → Settings, so the day this lands nothing changes — the same
-- rule every new setting in this CRM follows.
--
-- The category matters and has cost a day before: `PUT /api/admin/settings`
-- inserts a key it has never seen with **no category**, which lands it in
-- `general` from the server's side while a screen asking for a named one never
-- sees it again. Creating the row up front with its category settles it.
INSERT INTO ipy_setting (key, value, category, label, description)
VALUES (
  'data.min_profile_strength',
  '0'::jsonb,
  'data_quality',
  'Minimum profile strength (%)',
  'How complete a contact or inventory record is expected to be. Whoever owns a record under this gets one reminder a day, with a link to their own thin records. 0 switches the reminders off. It never blocks a save: a lead taken down mid-call has to be allowed in with a name and a number.'
)
ON CONFLICT (key) DO NOTHING;

UPDATE ipy_setting SET category = 'data_quality'
WHERE key = 'data.min_profile_strength' AND category <> 'data_quality';
