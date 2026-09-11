-- Properties use the owner's / contact's Mobile as their one identity.
-- Unit Number is deliberately not unique: identical unit numbers legitimately
-- occur in different projects, towers and phases.

DO $property_mobile$
DECLARE
  property_module uuid;
BEGIN
  SELECT id INTO property_module FROM ipy_module WHERE name = 'properties';
  IF property_module IS NULL THEN RETURN; END IF;

  UPDATE ipy_module
     SET duplicate_check_fields = '["mobile"]'::jsonb
   WHERE id = property_module;

  -- Production already has this custom field. Mark it required/unique in the
  -- metadata so normal forms, quick-create and every importer all obey the
  -- same rule. If an older tenant has no Mobile yet, the seed creates it with
  -- these same settings immediately after migrations.
  UPDATE ipy_field
     SET is_mandatory = true,
         is_unique = true,
         quick_create = true,
         config = COALESCE(config, '{}'::jsonb) || '{"digits":10,"codePrefix":"+91"}'::jsonb,
         updated_at = now()
   WHERE module_id = property_module AND name = 'mobile';
END $property_mobile$;
