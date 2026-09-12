-- The second "My Leads" my own cleanup was supposed to remove.
--
-- Migration 135 deleted every view on leads and properties except the four the
-- product ships, and matched them like this:
--
--     COALESCE(v.seed_key, v.name) NOT IN ('All Leads', 'My Leads', …)
--
-- `seed_key` is set on a view the seed created and null on one a person made.
-- So for a *user-created* view named "My Leads", COALESCE fell through to its
-- name, the name was in the keep list, and it survived — which is the one row
-- the migration existed to remove. The switcher still shows two.
--
-- This removes a view that is not a system view and whose name collides with a
-- system view in the same module. Narrower than 135 on purpose: he can create
-- views now, and a blanket delete would take away anything made since.
--
-- Two exclusions that matter:
--
--   * `is_system` — the built-in ones, obviously.
--   * `overrides_view_id IS NOT NULL` — a personal override *is* named after
--     the built-in view it overrides; that is the whole design (135). Deleting
--     those would silently throw away everybody's edited columns and filters.

DELETE FROM ipy_view v
USING ipy_module m
WHERE m.id = v.module_id
  AND v.is_system = false
  AND v.overrides_view_id IS NULL
  AND EXISTS (
    SELECT 1 FROM ipy_view sys
     WHERE sys.module_id = v.module_id
       AND sys.is_system = true
       AND sys.name = v.name
  );
