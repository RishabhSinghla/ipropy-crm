-- Dead storage goes: a payload column no field points at any more.
--
-- Production's properties table carries about twenty columns nothing reads —
-- carpet_area, configuration and the rest. They arrived because migration 110
-- was rewritten several times in one afternoon: one version added every column
-- 002 declares, that version ran and was *recorded* during a deploy that failed
-- on a later migration, and when 110 was narrowed afterwards it never re-ran.
-- So the columns stayed, their fields did not.
--
-- Harmless but not free: they are in `to_jsonb(p)`, they are in every backup,
-- and the next person reading the schema has to work out which twenty of the
-- forty names mean anything.
--
-- Three things make this safe enough to do automatically:
--
--   1. **The set is computed here, not written down.** A hardcoded list would
--      be right about production this evening and wrong about every other
--      database, including the one this runs against next. The rule is
--      "no ipy_field row on this module names this column" — matched on
--      `column_name`, never on `name`, because a renamed field keeps its
--      original column and matching on the name would delete live data.
--   2. **Nothing is lost.** Every non-null value is copied into
--      `ipy_dropped_column` first, with its record id, so a mistake is a
--      recoverable one. The table is small by construction — only columns
--      nothing owns can contribute to it.
--   3. **It cannot run on an empty model.** Migrations run *before* the seed,
--      so on a fresh install `ipy_field` is empty and every column would look
--      dead. The guard below refuses to touch a module with fewer than five
--      column-backed fields, which no real installation ever has.
--   4. **A tombstone is required, not just a missing field.** "No field points
--      here" on its own is too wide: it also catches columns the *template*
--      moved past years ago — `first_name` and `last_name`, merged into
--      `full_name` by migration 026 — and, more seriously, the consent mirror
--      columns. A tombstone means a person deliberately deleted that field and
--      the column should have gone with it, which is exactly the case this
--      exists for and nothing else.
--
-- And consent is excluded outright even when it is tombstoned. `do_not_call`,
-- `do_not_whatsapp` and `email_opt_out` are somebody's answer to "stop
-- contacting me". Deleting that answer is not a schema tidy-up whatever the
-- metadata says, and it has already gone wrong once — those three were removed
-- in August and every click-to-call failed for three weeks. If they are ever
-- to go it should be a deliberate act with that sentence attached, not a
-- side-effect of a sweep.

CREATE TABLE IF NOT EXISTS ipy_dropped_column (
  id          BIGSERIAL PRIMARY KEY,
  table_name  TEXT        NOT NULL,
  column_name TEXT        NOT NULL,
  record_id   UUID,
  value       TEXT,
  dropped_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE ipy_dropped_column IS
  'Values from payload columns removed because no field pointed at them. Read it to recover one; safe to truncate once nobody wants them.';

CREATE INDEX IF NOT EXISTS idx_dropped_column_lookup
  ON ipy_dropped_column (table_name, column_name);

DO $sweep$
DECLARE
  t            text;
  col          text;
  live_fields  int;
  archived     bigint;
  dropped_list text := '';
BEGIN
  FOREACH t IN ARRAY ARRAY['ipy_e_leads', 'ipy_e_properties'] LOOP
    SELECT count(*) INTO live_fields
      FROM ipy_field f JOIN ipy_module m ON m.id = f.module_id
     WHERE m.table_name = t AND f.storage = 'column';

    -- The fresh-install guard. It also covers a module somebody has genuinely
    -- emptied: doing nothing is the right answer there too.
    IF live_fields < 5 THEN
      RAISE NOTICE '% has only % column-backed fields — too few to trust, skipping', t, live_fields;
      CONTINUE;
    END IF;

    FOR col IN
      SELECT c.column_name
        FROM information_schema.columns c
       WHERE c.table_name = t
         -- The join and the JSONB bag are structure, not fields.
         AND c.column_name NOT IN ('record_id', 'custom_fields')
         -- Consent is never swept. See the note at the top of this file.
         AND c.column_name NOT IN ('do_not_call', 'do_not_whatsapp', 'email_opt_out')
         -- Nothing points at it…
         AND NOT EXISTS (
               SELECT 1 FROM ipy_field f JOIN ipy_module m ON m.id = f.module_id
                WHERE m.table_name = t
                  AND f.storage = 'column'
                  AND f.column_name = c.column_name)
         -- …and somebody deliberately deleted the field that used to.
         AND EXISTS (
               SELECT 1 FROM ipy_field_tombstone ts JOIN ipy_module m2 ON m2.name = ts.module_name
                WHERE m2.table_name = t
                  AND COALESCE(ts.column_name, ts.field_name) = c.column_name)
       ORDER BY c.column_name
    LOOP
      EXECUTE format(
        'INSERT INTO ipy_dropped_column (table_name, column_name, record_id, value)
           SELECT %L, %L, record_id, %I::text FROM %I WHERE %I IS NOT NULL',
        t, col, col, t, col);
      GET DIAGNOSTICS archived = ROW_COUNT;

      EXECUTE format('ALTER TABLE %I DROP COLUMN %I', t, col);
      dropped_list := dropped_list || format('%s.%s (%s values kept), ', t, col, archived);
    END LOOP;
  END LOOP;

  IF dropped_list = '' THEN
    RAISE NOTICE 'no dead columns — every column has a field pointing at it';
  ELSE
    RAISE NOTICE 'removed: %', left(dropped_list, length(dropped_list) - 2);
  END IF;
END $sweep$;
