-- Existing managers have always seen records belonging to their reports. Keep
-- that behaviour after hierarchy visibility became an explicit role setting;
-- an administrator can now turn it off per role in Roles & Profiles.
UPDATE ipy_profile
SET capabilities = capabilities || jsonb_build_array('records.view_lower_hierarchy')
WHERE NOT capabilities @> '["records.view_lower_hierarchy"]'::jsonb;
