-- AI Grade goes, entirely.
--
-- The owner's words: "not at all relevant for us at all, strip everything of it
-- away". Fair. A lead already carries a 0-100 score and a Hot/Warm/Cold
-- temperature; an A-to-D letter derived from that same score is a third way of
-- saying the same thing, and a team reading three labels for one number starts
-- ignoring all three.
--
-- Removed with it: the picklist, the three threshold settings that decided where
-- one letter became another, the field permission entry, and the `grade` key on
-- the AI scoring result. The score, the temperature and the reasons all stay.
--
-- **Both tombstones matter.** `docker-entrypoint.sh` re-seeds on every cold
-- start, so a deleted `ipy_field` row comes straight back and so does a deleted
-- picklist. `ipy_field_tombstone` and `ipy_picklist_tombstone` are what make a
-- deletion survive a restart — this is the trap that has caught this codebase
-- before, and the seed consults both.
--
-- The column is dropped last, after the metadata, so nothing can read a field
-- whose storage has already gone.

-- 1. Tombstone the field, so the seed does not rebuild it. `storage` and
--    `column_name` are recorded because that is what a later restore would need.
INSERT INTO ipy_field_tombstone (module_name, field_name, storage, column_name, had_values)
SELECT 'leads', 'ai_grade', 'column', 'ai_grade',
       (SELECT count(*) FROM ipy_e_leads WHERE ai_grade IS NOT NULL)
ON CONFLICT (module_name, field_name) DO NOTHING;

-- 2. Tombstone the whole dropdown. A row with value = '' means the entire set.
INSERT INTO ipy_picklist_tombstone (picklist_name, value, had_records)
SELECT 'ai_grade', '', (SELECT count(*) FROM ipy_e_leads WHERE ai_grade IS NOT NULL)
ON CONFLICT (picklist_name, value) DO NOTHING;

-- 3. Take it out of every saved view, report, workflow condition and widget
--    that names it, so nothing is left pointing at a field that is gone.
UPDATE ipy_view
   SET columns = COALESCE((SELECT jsonb_agg(c) FROM jsonb_array_elements(columns) c
                            WHERE c #>> '{}' <> 'ai_grade'), '[]'::jsonb)
 WHERE columns @> '["ai_grade"]'::jsonb;

UPDATE ipy_view SET sort_by = NULL WHERE sort_by = 'ai_grade';
UPDATE ipy_view SET group_by = NULL WHERE group_by = 'ai_grade';

-- Layouts hold their blocks and field lists as JSON in `config`, not as rows,
-- so the field has to be filtered out of every block's list. Also the header
-- fields, which are a separate flat list on the same object.
UPDATE ipy_layout
   SET config = jsonb_set(
         CASE WHEN config ? 'header'
           THEN jsonb_set(config, '{header}',
                  COALESCE((SELECT jsonb_agg(h) FROM jsonb_array_elements(config->'header') h
                             WHERE h #>> '{}' <> 'ai_grade'), '[]'::jsonb))
           ELSE config END,
         '{blocks}',
         COALESCE((
           SELECT jsonb_agg(
             CASE WHEN b ? 'fields'
               THEN jsonb_set(b, '{fields}',
                      COALESCE((SELECT jsonb_agg(f) FROM jsonb_array_elements(b->'fields') f
                                 WHERE f #>> '{}' <> 'ai_grade'), '[]'::jsonb))
               ELSE b END)
           FROM jsonb_array_elements(config->'blocks') b
         ), '[]'::jsonb))
 WHERE config ? 'blocks' AND config::text LIKE '%ai_grade%';

-- 4. The metadata row itself.
DELETE FROM ipy_field
 WHERE name = 'ai_grade'
   AND module_id IN (SELECT id FROM ipy_module WHERE name = 'leads');

DELETE FROM ipy_picklist_value
 WHERE picklist_id IN (SELECT id FROM ipy_picklist WHERE name = 'ai_grade');
DELETE FROM ipy_picklist WHERE name = 'ai_grade';

-- 5. The thresholds that only existed to decide where A became B.
DELETE FROM ipy_setting
 WHERE key IN ('scoring.grade_a_at', 'scoring.grade_b_at', 'scoring.grade_c_at');

-- 6. And the storage. Last, because a field whose column is gone but whose
--    metadata remains is a 42703 on every read of that module.
ALTER TABLE ipy_e_leads DROP COLUMN IF EXISTS ai_grade;
