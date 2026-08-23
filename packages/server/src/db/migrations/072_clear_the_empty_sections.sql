-- Remove the empty sections he asked to be rid of, on whatever database this runs against.
--
-- He deleted KYC and the others in the admin panel days ago and they are still
-- on the leads screen, because the deletions predate the tombstone table that
-- makes a deletion durable (066). The button works properly now; these are the
-- ones already stranded.
--
-- **Only where empty, and never the last one.** This does exactly what pressing
-- Delete does today (api/routes/metadata.ts): refuse a section holding fields,
-- refuse to leave a module with nowhere to put a field, write a tombstone so
-- the cold-start seed cannot rebuild it, and drop the section out of every
-- saved layout. A migration that deleted a section outright would take its
-- fields with it, and the copy on his production database does not necessarily
-- hold the same fields as the copy on mine.
DO $$
DECLARE
  target   RECORD;
  siblings INT;
BEGIN
  FOR target IN
    SELECT b.id, b.name, b.label, b.module_id, m.name AS module_name
      FROM ipy_block b
      JOIN ipy_module m ON m.id = b.module_id
     WHERE m.name = 'leads'
       AND b.name IN ('kyc', 'preferences', 'more')
       -- Empty. A section someone has since put a field into is a section
       -- someone is using, whatever it was called when he asked.
       AND NOT EXISTS (SELECT 1 FROM ipy_field f WHERE f.block_id = b.id)
  LOOP
    SELECT count(*) INTO siblings FROM ipy_block WHERE module_id = target.module_id;
    CONTINUE WHEN siblings <= 1;

    INSERT INTO ipy_block_tombstone (module_name, block_name, label)
    VALUES (target.module_name, target.name, target.label)
    ON CONFLICT (module_name, block_name) DO NOTHING;

    DELETE FROM ipy_block WHERE id = target.id;

    -- Layouts name their sections by the block's `name`, not its id, so a
    -- deleted section leaves a dangling key behind and the designer renders a
    -- section that no longer exists.
    UPDATE ipy_layout
       SET config = jsonb_set(config, '{blocks}', COALESCE((
             SELECT jsonb_agg(b) FROM jsonb_array_elements(config -> 'blocks') AS b
              WHERE b ->> 'key' <> target.name
           ), '[]'::jsonb))
     WHERE module_id = target.module_id
       AND jsonb_typeof(config -> 'blocks') = 'array';

    RAISE NOTICE 'removed empty section %.%', target.module_name, target.name;
  END LOOP;
END $$;
