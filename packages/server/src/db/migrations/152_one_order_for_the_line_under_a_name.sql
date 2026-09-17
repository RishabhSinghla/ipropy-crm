-- The two facts under a name read in the same order on every module.
--
-- Leads and Inventory both carry Contact Type and Unit Number, and the line
-- under the name took them in field order — which differs per module. So the
-- same two facts appeared as "Builder — B-118" on one screen and
-- "B-118 — Builder" on the other, and somebody moving between them reads that
-- as two different things.
--
-- `listSubtitle` carries the position now. It stays truthy either way, so a
-- field left at `true` is still included and simply sorts first.
UPDATE ipy_field f
   SET config = coalesce(f.config, '{}'::jsonb) || '{"listSubtitle": 1}'::jsonb
 WHERE f.name = 'contact_type'
   AND coalesce(f.config, '{}'::jsonb) ? 'listSubtitle';

UPDATE ipy_field f
   SET config = coalesce(f.config, '{}'::jsonb) || '{"listSubtitle": 2}'::jsonb
 WHERE f.name IN ('unit_number', 'unit_no')
   AND coalesce(f.config, '{}'::jsonb) ? 'listSubtitle';
