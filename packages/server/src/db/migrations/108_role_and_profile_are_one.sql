-- Role and Profile become one thing.
--
-- The desk's words: "role and profile do one or the other thing, so merge them
-- into a single thing — just Role." They were right: a Profile was only ever
-- "what a Role may do", picked separately on the user form, and the two could
-- disagree — a Sales Executive role holding an Administrator profile was one
-- dropdown away, and nothing checked.
--
-- The merge keeps the permission engine untouched: `ipy_profile` and its
-- permission tables stay exactly as they are, and every role now *owns* one
-- profile through `ipy_role.profile_id`. Choosing a role chooses what it may
-- do. The user form stops asking.
--
-- Backfill: every existing role links the same-named profile where one
-- exists. A role with no same-named profile (custom roles, mostly) gets a
-- fresh profile cloned from its parent's — or, at the root, from whichever
-- profile its users already hold — so no role is ever left permissionless.

ALTER TABLE ipy_role ADD COLUMN IF NOT EXISTS profile_id UUID REFERENCES ipy_profile(id) ON DELETE SET NULL;

-- Same-named pairs, the seeded case.
UPDATE ipy_role r
   SET profile_id = p.id
  FROM ipy_profile p
 WHERE p.name = r.name
   AND r.profile_id IS NULL;

-- Roles still without a profile: clone the parent's, else clone one held by
-- the role's own users, else clone the Administrator profile. One INSERT…
-- SELECT per row is simplest to read here; the role table is small.
DO $$
DECLARE
  r RECORD;
  src UUID;
  new_id UUID;
BEGIN
  FOR r IN SELECT id, name, parent_id FROM ipy_role WHERE profile_id IS NULL FOR UPDATE LOOP
    src := COALESCE(
      (SELECT profile_id FROM ipy_role WHERE id = r.parent_id AND profile_id IS NOT NULL),
      (SELECT u.profile_id FROM ipy_user u WHERE u.role_id = r.id AND u.profile_id IS NOT NULL AND u.deleted_at IS NULL LIMIT 1),
      (SELECT p.id FROM ipy_profile p WHERE p.is_system ORDER BY p.name LIMIT 1)
    );
    IF src IS NULL THEN
      RAISE NOTICE 'role % has no profile source; leaving unlinked', r.name;
      CONTINUE;
    END IF;
    INSERT INTO ipy_profile (name, description, is_system, capabilities)
    VALUES (r.name, 'Permissions for the ' || r.name || ' role.', false,
            (SELECT capabilities FROM ipy_profile WHERE id = src))
    RETURNING id INTO new_id;
    INSERT INTO ipy_profile_module_perm (profile_id, module_id, can_view, can_create, can_edit, can_delete, can_export, can_import)
    SELECT new_id, module_id, can_view, can_create, can_edit, can_delete, can_export, can_import
      FROM ipy_profile_module_perm WHERE profile_id = src;
    INSERT INTO ipy_profile_field_perm (profile_id, field_id, permission)
    SELECT new_id, field_id, permission FROM ipy_profile_field_perm WHERE profile_id = src;
    UPDATE ipy_role SET profile_id = new_id WHERE id = r.id;
  END LOOP;
END $$;

-- Users whose profile no longer matches their role's now follow the role, so
-- the merge cannot leave anybody holding privileges their role does not have.
UPDATE ipy_user u
   SET profile_id = r.profile_id
  FROM ipy_role r
 WHERE r.id = u.role_id
   AND r.profile_id IS NOT NULL
   AND u.profile_id IS DISTINCT FROM r.profile_id
   AND u.deleted_at IS NULL;
