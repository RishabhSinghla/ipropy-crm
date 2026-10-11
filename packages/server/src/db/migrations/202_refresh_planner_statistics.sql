-- Teach the query planner the shape of the tables again.
--
-- 11 October 2026: lists got slow. Production's own plan for "first page of
-- the newest contacts" expected 60 rows from ipy_record and got 14,365. The
-- cause is migration 201, which added `archived_at` after the last
-- statistics run: a column with no statistics is guessed at one half of one
-- percent, so every `archived_at IS NULL` in every list was believed to throw
-- almost everything away. A planner that believes that picks plans for 60
-- rows and then meets 14,000.
--
-- ANALYZE reads a sample and writes statistics only. It changes no row, takes
-- no lock that blocks reads or writes, and is safe to run again.
ANALYZE ipy_record;
ANALYZE ipy_e_leads;
ANALYZE ipy_e_properties;
