-- ===========================================================================
-- iPropy CRM — 028: Projects and Properties become one place
--
-- A project is a container for units. Keeping them as two menu entries meant
-- deciding which one you wanted before you could look at either, and the answer
-- is nearly always "the units, in that project".
--
-- Rather than merging the tables — a project genuinely is not a flat, and
-- collapsing them would put twenty empty columns on every row — the two modules
-- share a *tab group*. One entry in the menu; a tab strip inside it.
--
-- `settings.tabGroup` is read generically by the list screen: any modules that
-- name the same group render as tabs of one another. Nothing in the UI knows
-- what "inventory" means, so an admin can group a pair of custom modules the
-- same way without a deploy.
-- ===========================================================================

UPDATE ipy_module
SET settings = jsonb_set(
      COALESCE(settings, '{}'::jsonb),
      '{tabGroup}',
      '"inventory"'::jsonb,
      true
    )
WHERE name IN ('properties', 'projects');

-- Tab order within the group: units first, because that is what people came
-- for. `tabOrder` rather than `sequence` — the latter still orders the menu,
-- and Projects is not in the menu at all.
UPDATE ipy_module
SET settings = jsonb_set(settings, '{tabOrder}', '10'::jsonb, true)
WHERE name = 'properties';

UPDATE ipy_module
SET settings = jsonb_set(settings, '{tabOrder}', '20'::jsonb, true)
WHERE name = 'projects';
