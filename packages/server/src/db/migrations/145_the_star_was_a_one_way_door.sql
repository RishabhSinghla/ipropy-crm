-- Starring a record was easy. Finding what you had starred was not.
--
-- The star on a record means "come back to this", and there was no back: you
-- could mark one from anywhere and then had to remember where it was. This
-- adds "Favourite Leads" and "Favourite Inventories" beside All, My and
-- Unread.
--
-- `favourite` is a system filter field over `ipy_starred` (see the query
-- builder), so the list is per-person the way My Leads is — your stars, not
-- the team's.
--
-- Create-only and tombstone-aware, the same shape as 142: the seed writes
-- these on a cold start, this reaches a database that is already running, and
-- neither may resurrect a view somebody deleted on purpose.

INSERT INTO ipy_view (module_id, name, seed_key, columns, filter, sort_dir,
                      display_mode, is_public, is_system, sequence)
SELECT m.id,
       CASE m.name WHEN 'leads' THEN 'Favourite Leads' ELSE 'Favourite Inventories' END,
       CASE m.name WHEN 'leads' THEN 'Favourite Leads' ELSE 'Favourite Inventories' END,
       '[]'::jsonb,
       '{"logic":"AND","conditions":[{"field":"favourite","operator":"is_true"}]}'::jsonb,
       'desc', 'table', true, true, 3
  FROM ipy_module m
 WHERE m.name IN ('leads', 'properties')
   AND NOT EXISTS (
     SELECT 1 FROM ipy_view v
      WHERE v.module_id = m.id
        AND v.overrides_view_id IS NULL
        AND COALESCE(v.seed_key, v.name) = CASE m.name
              WHEN 'leads' THEN 'Favourite Leads' ELSE 'Favourite Inventories' END
   )
   AND NOT EXISTS (
     SELECT 1 FROM ipy_view_tombstone t
      WHERE t.module_id = m.id
        AND t.seed_key = CASE m.name
              WHEN 'leads' THEN 'Favourite Leads' ELSE 'Favourite Inventories' END
   );
