-- Two list views per module, and sharing one with named people.
--
-- Three things, all about the view switcher on Leads and Inventories.
--
-- 1. The switcher had grown a tail: the two the template ships plus whatever
--    anybody had saved for themselves, all in one flat list with no way to
--    tell which was which. The product ships exactly two — "All <module>" and
--    "My <module>" — and everything else is something a person made on
--    purpose and can make again. The extras are removed here.
--
--    This deletes saved views. It is deliberate and it was asked for; the two
--    that remain are the two the switcher is supposed to open with.
--
-- 2. The two that remain get the defaults they are supposed to have. The seed
--    is create-only for a view that already exists — correct, because a system
--    view is editable and re-seeding must not undo what an admin arranged —
--    so the rows already in a live database keep whatever they were created
--    with. Only a migration can restate them.
--
--    All:  every column, no filter, newest change first.
--    My:   every column, assigned to me, newest change first.
--
--    `columns = '[]'` is not "no columns". The list reads an empty array as
--    "this view has not picked any, so show them all", which is what makes
--    "all columns" survive a field being added later. A hand-written list
--    would freeze today's fields into data — the trap migration 132 was
--    written about.
--
--    `owner_id` rather than the field's name. The assignment field is called
--    `assigned_to` here and `owner_id` is only its column, and it has been
--    renamed before; `owner_id` is a system field in the query builder and
--    resolves whatever the field is called this month.
--
--    `sort_by = NULL` means the list's own default, which is `updated_at`
--    descending. Naming the column outright would break the same way a
--    hand-written column list does.
--
-- 3. Sharing a view is per person now, not all-or-nothing. `is_public` said
--    "everyone who can open this module" and there was nothing between that
--    and nobody. The switch in the editor now asks who, and the answer lives
--    here. `is_public` is untouched and still means everyone — the two system
--    views use it and should.

CREATE TABLE IF NOT EXISTS ipy_view_share (
  view_id    uuid NOT NULL REFERENCES ipy_view(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES ipy_user(id) ON DELETE CASCADE,
  shared_by  uuid REFERENCES ipy_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (view_id, user_id)
);

-- The lookup is always "which views is this person allowed to see", so the
-- user is the leading column of the index the list query actually uses.
CREATE INDEX IF NOT EXISTS idx_view_share_user ON ipy_view_share (user_id, view_id);

-- 1. Everything but the two.
DELETE FROM ipy_view v
USING ipy_module m
WHERE m.id = v.module_id
  AND m.name IN ('leads', 'properties')
  AND COALESCE(v.seed_key, v.name) NOT IN
      ('All Leads', 'My Leads', 'All Inventories', 'My Inventories');

-- 2. The two, restated.
UPDATE ipy_view v
SET columns    = '[]'::jsonb,
    filter     = '{"logic":"AND","conditions":[]}'::jsonb,
    sort_by    = NULL,
    sort_dir   = 'desc',
    is_default = true,
    is_public  = true,
    is_system  = true,
    is_active  = true,
    sequence   = 0,
    updated_at = now()
FROM ipy_module m
WHERE m.id = v.module_id
  AND COALESCE(v.seed_key, v.name) IN ('All Leads', 'All Inventories');

UPDATE ipy_view v
SET columns    = '[]'::jsonb,
    filter     = '{"logic":"AND","conditions":[{"field":"owner_id","operator":"is_me"}]}'::jsonb,
    sort_by    = NULL,
    sort_dir   = 'desc',
    is_default = false,
    is_public  = true,
    is_system  = true,
    is_active  = true,
    sequence   = 1,
    updated_at = now()
FROM ipy_module m
WHERE m.id = v.module_id
  AND COALESCE(v.seed_key, v.name) IN ('My Leads', 'My Inventories');

-- A tombstone for either of the two would keep the seed from putting it back
-- on the next cold start, and this migration exists to say both must be there.
DELETE FROM ipy_view_tombstone t
USING ipy_module m
WHERE m.id = t.module_id
  AND m.name IN ('leads', 'properties')
  AND t.seed_key IN ('All Leads', 'My Leads', 'All Inventories', 'My Inventories');

-- 4. Editing a built-in view gives you your own copy of it.
--
-- The two system views are one row each, shared by the whole team, so an
-- editable system view meant one person's column choice landing on everybody's
-- screen. It is still editable — by anyone — but the edit is saved as that
-- person's own version of that view, keyed here. They see theirs, everyone
-- else goes on seeing the built-in one, and deleting the override puts them
-- back on it.
--
-- One per person per view, so the editor updates rather than piling up copies.
ALTER TABLE ipy_view ADD COLUMN IF NOT EXISTS overrides_view_id uuid
  REFERENCES ipy_view(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_view_override_per_user
  ON ipy_view (overrides_view_id, owner_id)
  WHERE overrides_view_id IS NOT NULL;
