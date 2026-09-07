-- Lifecycle Stage goes, entirely.
--
-- The owner's words: "lifecycle stage is absolutely bullshit to us and of no
-- use at all". It was a second, read-only copy of the pipeline that followed
-- the status field; one relationship axis the reports disagreed with. Status
-- is the pipeline and the relationship both.
--
-- Removed with it: the picklist, the stage-from-status setting, the workflow
-- task option, and the inbound-match ranking that ordered by it (the ranking
-- moves to status so customers still surface first). The seed no longer
-- declares the field, so the tombstone is what keeps it gone on re-seed.

-- 1. Tombstone the field, so the seed does not rebuild it.
INSERT INTO ipy_field_tombstone (module_name, field_name, storage, column_name, had_values)
SELECT 'leads', 'lifecycle_stage', 'column', 'lifecycle_stage',
       (SELECT count(*) FROM ipy_e_leads WHERE lifecycle_stage IS NOT NULL)
ON CONFLICT (module_name, field_name) DO NOTHING;

-- 2. Tombstone the whole dropdown.
INSERT INTO ipy_picklist_tombstone (picklist_name, value, had_records)
SELECT 'lifecycle_stage', '', (SELECT count(*) FROM ipy_e_leads WHERE lifecycle_stage IS NOT NULL)
ON CONFLICT (picklist_name, value) DO NOTHING;

-- 3. Views, layouts, widgets, workflows and profile permissions that name it.
UPDATE ipy_view
   SET columns = COALESCE((SELECT jsonb_agg(c) FROM jsonb_array_elements(columns) c
                            WHERE c #>> '{}' <> 'lifecycle_stage'), '[]'::jsonb)
 WHERE columns @> '["lifecycle_stage"]'::jsonb;

UPDATE ipy_view SET sort_by = NULL WHERE sort_by = 'lifecycle_stage';
UPDATE ipy_view SET group_by = NULL WHERE group_by = 'lifecycle_stage';

-- A filter that named it loses that condition rather than guess a mapping, so
-- a view never silently matches everything. The filter is an object
-- {logic, conditions[]}, so the array being rebuilt lives under 'conditions'
-- and may be absent entirely on a view with no conditions at all.
UPDATE ipy_view
   SET filter = CASE WHEN jsonb_typeof(filter->'conditions') = 'array'
     THEN jsonb_set(filter, '{conditions}',
            COALESCE((SELECT jsonb_agg(c) FROM jsonb_array_elements(filter->'conditions') c
                       WHERE c->>'field' <> 'lifecycle_stage'), '[]'::jsonb))
     ELSE filter END
 WHERE filter IS NOT NULL AND filter::text LIKE '%lifecycle_stage%';

-- Layouts: drop the field from every block outright. Rewriting the name to
-- "status" instead would duplicate it where a block already showed the
-- pipeline status — the block that carried both was exactly the confusion
-- being retired.
UPDATE ipy_layout
   SET config = jsonb_set(config, '{blocks}', COALESCE((
         SELECT jsonb_agg(
                  CASE WHEN b ? 'fields'
                    THEN jsonb_set(b, '{fields}',
                           COALESCE((SELECT jsonb_agg(f) FROM jsonb_array_elements(b->'fields') f
                                      WHERE f #>> '{}' <> 'lifecycle_stage'), '[]'::jsonb))
                    ELSE b END)
           FROM jsonb_array_elements(config->'blocks') b
         ), '[]'::jsonb))
 WHERE config ? 'blocks' AND config::text LIKE '%lifecycle_stage%';

UPDATE ipy_workflow
   SET conditions = CASE WHEN jsonb_typeof(conditions->'conditions') = 'array'
     THEN jsonb_set(conditions, '{conditions}',
            COALESCE((SELECT jsonb_agg(c) FROM jsonb_array_elements(conditions->'conditions') c
                       WHERE c->>'field' <> 'lifecycle_stage'), '[]'::jsonb))
     ELSE conditions END
 WHERE conditions IS NOT NULL AND conditions::text LIKE '%lifecycle_stage%';

UPDATE ipy_workflow_task
   SET config = config - 'advanceLifecycle'
 WHERE config::text LIKE '%advanceLifecycle%';

DELETE FROM ipy_profile_field_perm
 WHERE field_id IN (SELECT id FROM ipy_field WHERE name = 'lifecycle_stage'
                    AND module_id IN (SELECT id FROM ipy_module WHERE name = 'leads'));

-- 4. The metadata rows themselves.
DELETE FROM ipy_field
 WHERE name = 'lifecycle_stage'
   AND module_id IN (SELECT id FROM ipy_module WHERE name = 'leads');

DELETE FROM ipy_picklist_value
 WHERE picklist_id IN (SELECT id FROM ipy_picklist WHERE name = 'lifecycle_stage');
DELETE FROM ipy_picklist WHERE name = 'lifecycle_stage';

-- 5. The setting that mapped status → stage.
DELETE FROM ipy_setting WHERE key = 'leads.stage_from_status';

-- 6. Storage last, after the metadata, so nothing reads a field whose column
--    is already gone.
ALTER TABLE ipy_e_leads DROP COLUMN IF EXISTS lifecycle_stage;
