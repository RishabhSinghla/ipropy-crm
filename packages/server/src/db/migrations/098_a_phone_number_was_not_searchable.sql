-- Pasting a missed call into the search box found nothing. Not "nothing you
-- may see" — nothing at all, for the lead's own owner and for an admin alike.
--
-- The cause was one flag: `search_text` is built from fields marked
-- `searchable`, and `mobile` is not one of them in the seed, so no phone number
-- ever reached the search index. It reads exactly like a sharing-rule problem
-- from the search box, and that is how it was reported.
--
-- recordService.buildSearchText now always includes phone fields — and both
-- forms of them, because the tokeniser reads `+91 98114 21156` and
-- `9811421156` as different words. That fixes every record written from now
-- on. This backfills the ones already here.
--
-- **Driven by metadata, not by a hand-written column list.** The first version
-- of this file named `mobile`, `alternate_phone` and `whatsapp_number` because
-- those are the phone fields on a developer's database. Production does not
-- have `whatsapp_number` — the field was deleted there — so the migration
-- failed on `column e.whatsapp_number does not exist` and took the whole
-- deploy down with it. That is the fifth time a hand-listed column has broken
-- against a database an admin had edited. The columns are discovered from
-- `ipy_field` and checked against `information_schema` before being named, so
-- a field added, renamed or deleted by an admin cannot break this again.

DO $$
DECLARE
  m           RECORD;
  f           RECORD;
  exprs       TEXT[];
  digits_expr TEXT;
  raw_expr    TEXT;
  sql         TEXT;
BEGIN
  -- Every entity module, not just leads: a phone field on properties (or on
  -- whatever an admin adds next) deserves the same treatment.
  FOR m IN
    SELECT id, table_name FROM ipy_module
     WHERE is_entity AND to_regclass('public.' || quote_ident(table_name)) IS NOT NULL
  LOOP
    exprs := ARRAY[]::TEXT[];

    FOR f IN
      SELECT column_name, storage FROM ipy_field
       WHERE module_id = m.id AND uitype = 'phone' AND is_active
    LOOP
      IF f.storage = 'json' THEN
        raw_expr := format('e.custom_fields->>%L', f.column_name);
      ELSE
        -- The guard that was missing: a metadata row can outlive its column
        -- (and vice versa), so ask the catalogue before naming it.
        CONTINUE WHEN NOT EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = m.table_name
             AND column_name = f.column_name
        );
        raw_expr := format('e.%I', f.column_name);
      END IF;

      digits_expr := format($f$regexp_replace(coalesce(%s, ''), '\D', '', 'g')$f$, raw_expr);
      exprs := exprs || raw_expr || digits_expr;
    END LOOP;

    CONTINUE WHEN cardinality(exprs) = 0;

    -- `position(... ) = 0` keeps this idempotent: a re-run must not append the
    -- same digits twice and push a long record's real words past the 4000-char
    -- cut. Compared on the first phone expression, which is the one every
    -- record has if it has any.
    sql := format($q$
      UPDATE ipy_record r
         SET search_text = left(trim(r.search_text || ' ' || concat_ws(' ', %s)), 4000)
        FROM %I e
       WHERE e.record_id = r.id
         AND r.module_id = %L
         AND nullif(%s, '') IS NOT NULL
         AND position(%s in r.search_text) = 0
    $q$, array_to_string(exprs, ', '), m.table_name, m.id, exprs[2], exprs[2]);

    EXECUTE sql;
  END LOOP;
END $$;

-- search_vector is maintained by trg_record_tsv on UPDATE OF search_text, so
-- the rows above have already been re-indexed by the time this file ends.
