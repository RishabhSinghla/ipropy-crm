-- Existing managers have always seen records belonging to their reports. Keep
-- that behaviour after hierarchy visibility became an explicit role setting;
-- an administrator can now turn it off per role in Roles & Profiles.
UPDATE ipy_profile
SET capabilities = array_append(capabilities, 'records.view_lower_hierarchy')
WHERE NOT ('records.view_lower_hierarchy' = ANY(capabilities));
