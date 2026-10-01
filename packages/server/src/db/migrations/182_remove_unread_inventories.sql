-- "Unread Inventories" goes — the owner, 1 October 2026: "completely rip off
-- from the system as its not needed".
--
-- The seed only ever creates views, never deletes them, so the live row has to
-- go here. The tombstone is what keeps it gone: without it the next cold start
-- would create the view again (see migration 128). "Unread Leads" stays.
INSERT INTO ipy_view_tombstone (module_id, seed_key)
SELECT m.id, 'Unread Inventories'
  FROM ipy_module m
 WHERE m.name = 'properties'
ON CONFLICT DO NOTHING;

DELETE FROM ipy_view v
 USING ipy_module m
 WHERE v.module_id = m.id
   AND m.name = 'properties'
   AND v.seed_key = 'Unread Inventories';
