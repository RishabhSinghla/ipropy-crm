-- "Leads 99+" is a number you cannot open. Now it is a view.
--
-- The header badge counts records that arrived after you last looked at the
-- module and that you have never opened — the CRM's version of an unread email.
-- It was a count and nothing else: you could see that ninety-nine things needed
-- looking at and had no way to list them.
--
-- `unread` is a system filter field (see `core/query/builder.ts`), so the view
-- is an ordinary saved view with an ordinary filter, and it works everywhere a
-- filter works — sorting, columns, the editor, saving your own version of it.
--
-- The seed creates these on a cold start; this adds them to a database that is
-- already running. Create-only and tombstone-aware, the same way `upsertViews`
-- behaves, so it cannot resurrect a view somebody deleted on purpose or
-- duplicate one that is already there.

INSERT INTO ipy_view (module_id, name, seed_key, columns, filter, sort_dir,
                      display_mode, is_public, is_system, sequence)
SELECT m.id,
       CASE m.name WHEN 'leads' THEN 'Unread Leads' ELSE 'Unread Inventories' END,
       CASE m.name WHEN 'leads' THEN 'Unread Leads' ELSE 'Unread Inventories' END,
       '[]'::jsonb,
       '{"logic":"AND","conditions":[{"field":"unread","operator":"is_true"}]}'::jsonb,
       'desc', 'table', true, true, 2
  FROM ipy_module m
 WHERE m.name IN ('leads', 'properties')
   AND NOT EXISTS (
     SELECT 1 FROM ipy_view v
      WHERE v.module_id = m.id
        AND COALESCE(v.seed_key, v.name) = CASE m.name
              WHEN 'leads' THEN 'Unread Leads' ELSE 'Unread Inventories' END
   )
   AND NOT EXISTS (
     SELECT 1 FROM ipy_view_tombstone t
      WHERE t.module_id = m.id
        AND t.seed_key = CASE m.name
              WHEN 'leads' THEN 'Unread Leads' ELSE 'Unread Inventories' END
   );
