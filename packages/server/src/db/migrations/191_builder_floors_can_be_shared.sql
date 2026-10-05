-- A house can be sent to a buyer as a brochure link.
--
-- `settings.shareable` is the per-module switch `canShareRecords` already
-- reads; the public page and `loadSharedRecord` were made module-generic when
-- Builder Floors landed, so this turns the existing door on rather than opening
-- a second one. What a visitor may read is still decided by `propertyShare.ts`,
-- which withholds the builder, his mobile, the locality and every internal
-- price by name.
--
-- A migration rather than the seed: `upsertModule` writes
-- `EXCLUDED.settings || ipy_module.settings`, so a module that already exists
-- never learns a newly seeded setting.
UPDATE ipy_module
SET settings = COALESCE(settings, '{}'::jsonb) || '{"shareable":true}'::jsonb
WHERE name = 'builder_floors';
