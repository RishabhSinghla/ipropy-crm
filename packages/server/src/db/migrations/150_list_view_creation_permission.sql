-- List-view editing has historically been available to every existing role.
-- Preserve that behaviour on upgrade; an administrator can now turn it off
-- deliberately in Roles & Profiles, rather than a deployment silently taking
-- away a team's saved working views.
UPDATE ipy_profile
SET capabilities = capabilities || jsonb_build_array('views.manage')
WHERE NOT capabilities @> '["views.manage"]'::jsonb;
