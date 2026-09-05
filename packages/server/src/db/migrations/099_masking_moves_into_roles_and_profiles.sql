-- Who may see a mobile number was a single global switch — one tick that hid
-- every number from every non-admin, or showed all of them to all of them.
-- Two things were wrong with it.
--
-- It was in the wrong place. Every other question of the form "may this person
-- see this field" is answered per profile in Roles & Profiles, and a rep, a
-- telecaller and a sales head do not need the same answer. Being a Settings
-- toggle also made it invisible to the person setting up a profile, who is
-- exactly the person deciding it.
--
-- And it was the wrong shape. The risk it exists for is a rep leaving with the
-- customer list; the person working the lead has to be able to ring them. So
-- the useful rule is not "hide from everyone" but "show to the owner" — which
-- a global setting cannot express, because it knows nothing about the record.
--
-- `owner_only` is that rule, alongside hidden / readonly / editable. It reads
-- normally for the record's owner and masks — `98xxxxxx56`, not a blank — for
-- everybody else, with the audited reveal endpoint unchanged behind it.

ALTER TABLE ipy_profile_field_perm DROP CONSTRAINT IF EXISTS ipy_profile_field_perm_permission_check;
ALTER TABLE ipy_profile_field_perm
  ADD CONSTRAINT ipy_profile_field_perm_permission_check
  CHECK (permission IN ('hidden', 'readonly', 'owner_only', 'editable'));

-- Carry the old switch across rather than silently changing what the team sees.
-- If masking was on, every non-admin profile gets `owner_only` on every phone
-- field, which is the closest honest translation: it was hiding numbers from
-- these people, and it still does — except from the one who owns the record,
-- which is the improvement. If it was off, nothing changes and every profile
-- keeps the default.
DO $$
DECLARE
  was_on boolean;
BEGIN
  SELECT value = 'true'::jsonb INTO was_on FROM ipy_setting WHERE key = 'privacy.mask_phone_numbers';
  IF coalesce(was_on, false) THEN
    INSERT INTO ipy_profile_field_perm (profile_id, field_id, permission)
    SELECT p.id, f.id, 'owner_only'
      FROM ipy_profile p
      CROSS JOIN ipy_field f
     WHERE f.uitype = 'phone'
       AND f.is_active
       -- Every profile: administrators are exempt by being administrators
       -- (getFieldPermissions short-circuits on ipy_user.is_admin), not by
       -- holding a particular profile — there is no admin flag on a profile.
    ON CONFLICT (profile_id, field_id) DO UPDATE
      -- Never loosen an existing decision: a field already fully hidden from a
      -- profile stays hidden.
      SET permission = CASE WHEN ipy_profile_field_perm.permission = 'hidden'
                            THEN 'hidden' ELSE 'owner_only' END;
  END IF;
END $$;

-- The switch is gone from Settings; leaving the row behind would leave a dead
-- key that a future reader would reasonably assume still does something.
DELETE FROM ipy_setting WHERE key = 'privacy.mask_phone_numbers';

-- And its neighbour, which never did anything at all. `telephony.mask_numbers`
-- has been offered under Admin → Settings → Calls since the seed was written
-- and is read by no code in this repository: turning it on or off changed
-- nothing, which is worse than not offering it. Number masking is the field
-- permission above.
DELETE FROM ipy_setting WHERE key = 'telephony.mask_numbers';
