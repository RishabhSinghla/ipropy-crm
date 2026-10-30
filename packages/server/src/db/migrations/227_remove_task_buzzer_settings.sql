-- The today-task buzzer and its popup were removed on 30 October 2026, on the
-- owner's instruction ("remove completely This Buzzer and POPup Feature").
--
-- Only its four settings rows go: they are configuration nothing reads any
-- more, and left behind they would show on Admin → Settings under a heading
-- the screen no longer has. Nothing else was stored — the buzzer's memory of
-- what it had shown lived in each browser, never in the database.
DELETE FROM ipy_setting WHERE key LIKE 'ui.task_buzzer_%';
