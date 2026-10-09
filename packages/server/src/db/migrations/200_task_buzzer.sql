-- The today-task buzzer's settings.
--
-- 9 October 2026, the owner: "in every 15 minute … first task to last task …
-- every lead form auto open like popup … only once time per day / per lead if
-- task more then 50 records, the form will be closed after 60 seconds … if task
-- below then 50 then remind regular after 15 minute … with a buzzer sound."
--
-- Seeded ON with his own numbers, because this is his instruction rather than a
-- feature waiting for somebody to want it. Admin → Settings → Today's tasks
-- switches it off or changes any number, live, with no deploy.
--
-- The keys start `ui.` so they ride on /api/auth/me with the other screen
-- settings (core/settings/ui.ts). The category is their own, not `ui`: the
-- Settings page hides `ui` rows because those are edited on screens of their
-- own, and these four have none. Created up front so a save cannot land them
-- in `general` (the trap migration 185 describes).
INSERT INTO ipy_setting (key, value, category, label, description) VALUES
  ('ui.task_buzzer_on', 'true'::jsonb, 'task_buzzer',
   'Pop up today''s tasks with a buzzer',
   'Every record whose follow-up is due today opens on the assigned person''s screen, one after another, with a buzzer — on a laptop or desktop, not the phone app. Off stops it for everybody.'),
  ('ui.task_buzzer_every_minutes', '15'::jsonb, 'task_buzzer',
   'Minutes between rounds',
   'How long after the last popup of one round the next round starts again from the first task. Between 1 and 240.'),
  ('ui.task_buzzer_once_over', '50'::jsonb, 'task_buzzer',
   'Once a day each, above this many tasks',
   'When somebody has more tasks due today than this, each record pops up only once that day and closes itself. At or under it, every task pops up every round until its date is moved.'),
  ('ui.task_buzzer_close_after_seconds', '60'::jsonb, 'task_buzzer',
   'Seconds before a popup closes itself (busy days)',
   'Only on a day over the number above. Between 10 and 600.')
ON CONFLICT (key) DO NOTHING;

UPDATE ipy_setting SET category = 'task_buzzer'
 WHERE key LIKE 'ui.task_buzzer_%' AND category <> 'task_buzzer';
