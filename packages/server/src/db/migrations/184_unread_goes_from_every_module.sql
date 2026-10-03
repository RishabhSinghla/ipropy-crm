-- Unread goes, on every module — the owner, 3 October 2026: "remove unread list
-- from all modules list completely and also remove unread functionality from all
-- records."
--
-- "Unread Inventories" went on 1 October (migration 182); this is the other half
-- plus the thing that makes it safe. The `unread` system filter field is gone
-- from the query builder in the same change, so ANY saved view still naming it
-- would fail the moment somebody opened it — which is why this deletes the views
-- rather than only the seeded one.
--
-- The seed only ever creates views, so the tombstone is what keeps the built-in
-- one gone: without it the next cold start would make it again (migration 128).

-- 1. The built-in ones, by their seed key, on every module.
INSERT INTO ipy_view_tombstone (module_id, seed_key)
SELECT v.module_id, v.seed_key
  FROM ipy_view v
 WHERE v.seed_key LIKE 'Unread %'
ON CONFLICT DO NOTHING;

DELETE FROM ipy_view WHERE seed_key LIKE 'Unread %';

-- 2. Anything anybody built by hand that asks the question another way. The
--    filter is JSONB, so this reads the stored text: a condition naming the
--    field is `"field":"unread"` however the rest of the view is shaped.
DELETE FROM ipy_view WHERE filter::text LIKE '%"field":"unread"%';

-- 3. A dashboard tile or a saved report asking the same question would break
--    identically — and a chart that refuses to load is harder for somebody to
--    explain than one that is simply not there.
DELETE FROM ipy_dashboard_widget WHERE config::text LIKE '%"field":"unread"%';
DELETE FROM ipy_report WHERE config::text LIKE '%"field":"unread"%';

-- `ipy_module_seen` is deliberately NOT dropped. Nothing reads it now, and a
-- migration in this repo never destroys a table — if unread is ever wanted back,
-- it starts from the watermarks the team already has rather than from nothing.
