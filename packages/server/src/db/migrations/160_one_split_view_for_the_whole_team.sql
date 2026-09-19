-- One split view for the whole team, set in Admin → Split View.
--
-- The split view is where most of the team now works all day, and the three
-- places a field can appear in it were set on three different screens: the
-- line under a name came from a per-field flag in the Field Manager, and the
-- record's header and form from the Layout Designer. `ui.split_view` is the
-- single answer now — `{ module: { queue, header, form } }`, each an ordered
-- list of field names.
--
-- **Seeded empty on purpose.** Every list left empty keeps exactly what the
-- CRM shows today: the queue falls back to the fields flagged
-- `config.listSubtitle`, and the header and the form to the Layout Designer's
-- arrangement. So this migration changes nothing anybody can see, and an admin
-- who opens the screen and leaves changes nothing either.
--
-- The row exists up front for one reason worth writing down: `PUT
-- /api/admin/settings` inserts a key it has never seen with **no category**,
-- so it lands in `general`, and Admin → Split View asks for the `ui` category
-- and would never read back what it had just written. The symptom is a
-- settings page that saves successfully and is empty the next time it opens.
INSERT INTO ipy_setting (key, value, category, label, description)
VALUES (
  'ui.split_view',
  '{}'::jsonb,
  'ui',
  'Split view fields',
  'What the split view shows, per module: the queue line, the record header and the form. Admin → Split View.'
)
ON CONFLICT (key) DO NOTHING;

-- And for a database where the row already exists in the wrong place, which is
-- every database this was tried on before the line above existed.
UPDATE ipy_setting SET category = 'ui' WHERE key = 'ui.split_view' AND category <> 'ui';
