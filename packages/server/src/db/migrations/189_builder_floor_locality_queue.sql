-- Group the left queue, not the underlying houses. House identities stay intact.
UPDATE ipy_module
SET settings = COALESCE(settings, '{}'::jsonb) || '{"queueGroupBy":"locality"}'::jsonb
WHERE name = 'builder_floors';
