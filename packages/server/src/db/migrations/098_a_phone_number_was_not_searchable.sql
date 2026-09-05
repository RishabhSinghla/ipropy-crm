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
-- Written against the phone columns that exist rather than derived from
-- metadata: this is a one-off repair of the rows in the table today, and the
-- engine, not the migration, is what stays metadata-driven. `IF EXISTS` on the
-- table so it no-ops on a database where the module was never created.

DO $$
BEGIN
  IF to_regclass('public.ipy_e_leads') IS NULL THEN RETURN; END IF;

  UPDATE ipy_record r
     SET search_text = left(
           trim(
             r.search_text || ' ' ||
             concat_ws(' ',
               e.mobile,            regexp_replace(coalesce(e.mobile, ''), '\D', '', 'g'),
               e.alternate_phone,   regexp_replace(coalesce(e.alternate_phone, ''), '\D', '', 'g'),
               e.whatsapp_number,   regexp_replace(coalesce(e.whatsapp_number, ''), '\D', '', 'g')
             )
           ), 4000)
    FROM ipy_e_leads e
   WHERE e.record_id = r.id
     AND coalesce(e.mobile, e.alternate_phone, e.whatsapp_number) IS NOT NULL
     -- Idempotent: a re-run must not append the same digits a second time and
     -- push a long record's real words past the 4000-character cut.
     AND position(regexp_replace(coalesce(e.mobile, e.alternate_phone, e.whatsapp_number), '\D', '', 'g') in r.search_text) = 0;
END $$;

-- search_vector is maintained by trg_record_tsv on UPDATE OF search_text, so
-- the rows above have already been re-indexed by the time this file ends.
