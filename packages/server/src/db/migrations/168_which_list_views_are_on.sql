-- Which of the three list views the team may use, set in Admin → List Views.
--
-- The table, the board and the split view all ship switched on, and a team
-- that only ever works one of them still sees three buttons and three ways for
-- two people to be looking at the same list differently. This is the one place
-- that decides which exist.
--
-- **Seeded with all three on**, so this migration changes nothing anybody can
-- see. Switching the last one off is refused on the screen and ignored here:
-- a list with no view is a blank page.
--
-- The row exists up front because `PUT /api/admin/settings` inserts a key it
-- has never seen with no category, so it lands in `general` while the admin
-- screen asks for `ui` — the symptom is a page that saves and reads back
-- empty. The same trap migration 160 records for `ui.split_view`.
INSERT INTO ipy_setting (key, value, category, label, description)
VALUES (
  'ui.list_views',
  '{"table": true, "kanban": true, "ipropy": true}'::jsonb,
  'ui',
  'List views',
  'Which list views the team may use: the table, the board and the split view. Admin → List Views.'
)
ON CONFLICT (key) DO NOTHING;

UPDATE ipy_setting SET category = 'ui' WHERE key = 'ui.list_views' AND category <> 'ui';
