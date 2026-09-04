-- Roles and profiles become the same four names.
--
-- The owner's call: one concept, not two. Profiles are what an admin manages
-- (what a person can do); each keeps a same-named role underneath, which is
-- what hierarchy scoping reads. The fourteen-role tree with its channel-
-- partner, marketing, finance and post-sales branches had no users hanging
-- off most of it, and every extra branch was one more guess on the new-user
-- form.
--
-- Renames first, so the seed's upserts match the survivors by name and
-- repair the hierarchy. Users on deleted branches move to the nearest
-- surviving job family before the delete, so nobody wakes up with a null
-- profile and no permissions.
--
-- Tele-caller becomes Telecaller: one word, the way it is said.

UPDATE ipy_role SET name = 'Telecaller' WHERE name = 'Tele-caller';
UPDATE ipy_role SET name = 'Administrator' WHERE name = 'CEO';

UPDATE ipy_user u
SET role_id = r2.id
FROM ipy_role r
JOIN ipy_role r2 ON r2.name = CASE
  WHEN r.name IN ('Sales Head', 'Regional Sales Manager', 'Pre-Sales Manager',
                  'CRM Head', 'Marketing Head', 'Finance Head', 'Channel Partner Manager')
    THEN 'Sales Manager'
  ELSE 'Sales Executive'
END
WHERE u.role_id = r.id
  AND r.name NOT IN ('Administrator', 'Sales Manager', 'Sales Executive', 'Telecaller');

UPDATE ipy_user u
SET profile_id = p2.id
FROM ipy_profile p, ipy_profile p2
WHERE u.profile_id = p.id
  AND p.name NOT IN ('Administrator', 'Sales Manager', 'Sales Executive', 'Telecaller')
  AND p2.name = CASE
    WHEN u.is_admin THEN 'Administrator'
    WHEN p.name ILIKE '%tele%' THEN 'Telecaller'
    WHEN p.name ILIKE '%manager%' OR p.name ILIKE '%head%' THEN 'Sales Manager'
    ELSE 'Sales Executive'
  END;

DELETE FROM ipy_profile
 WHERE name NOT IN ('Administrator', 'Sales Manager', 'Sales Executive', 'Telecaller');

DELETE FROM ipy_role
 WHERE name NOT IN ('Administrator', 'Sales Manager', 'Sales Executive', 'Telecaller');
