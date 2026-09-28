-- Associates are people already held as leads with Contact Type Dealer or
-- Builder. Keep each record ID: calls, comments, files, shares and chat links
-- then continue to belong to that same person. This whole migration runs in
-- the migration runner's transaction; a failed copy moves nobody.

CREATE TABLE ipy_e_associates (LIKE ipy_e_leads INCLUDING ALL);
ALTER TABLE ipy_e_associates
  ADD CONSTRAINT ipy_e_associates_record_fk
  FOREIGN KEY (record_id) REFERENCES ipy_record(id) ON DELETE CASCADE;

DO $$
DECLARE
  lead_module UUID;
  associate_module UUID;
BEGIN
  SELECT id INTO lead_module FROM ipy_module WHERE name = 'leads';

  -- Migrations run before the seed, so on a brand-new database there is no
  -- Leads module to clone yet and no Dealer or Builder to move. `INTO STRICT`
  -- raised there, which failed the whole migration run and took the integration
  -- suite and CI's "Prepare database" step with it. Migrations in this repo are
  -- written to no-op on a fresh database; this is that rule, met late.
  IF lead_module IS NULL THEN RETURN; END IF;

  INSERT INTO ipy_module (
    name, label, singular_label, table_name, icon, color, sequence,
    is_entity, is_custom, is_active, show_in_menu, menu_group,
    label_fields, pipeline_field, duplicate_check_fields,
    supports_comments, supports_attachments, supports_workflow,
    supports_tags, supports_conversion, settings
  )
  SELECT 'associates', 'Associates', 'Associate', 'ipy_e_associates',
         'users', color, (SELECT COALESCE(MAX(sequence), 0) + 10 FROM ipy_module),
         is_entity, false, true, true, menu_group,
         label_fields, pipeline_field, duplicate_check_fields,
         supports_comments, supports_attachments, supports_workflow,
         supports_tags, false, settings || '{"shortLabel":"ASC"}'::jsonb
    FROM ipy_module WHERE id = lead_module
  RETURNING id INTO associate_module;

  INSERT INTO ipy_block (
    module_id, name, label, sequence, is_collapsed, columns, is_custom,
    is_active, visible_when, is_customised
  )
  SELECT associate_module, name, label, sequence, is_collapsed, columns,
         is_custom, is_active, visible_when, is_customised
    FROM ipy_block WHERE module_id = lead_module;

  -- Internal field IDs are intentionally new and permanent. API names,
  -- storage columns and picklist bindings are identical to Leads.
  INSERT INTO ipy_field (
    module_id, block_id, name, label, uitype, storage, column_name,
    sequence, is_mandatory, is_readonly, is_unique, is_custom, is_active,
    display_type, default_value, max_length, help_text, config,
    quick_create, mass_editable, searchable, is_customised
  )
  SELECT associate_module, ab.id, f.name, f.label, f.uitype, f.storage,
         f.column_name, f.sequence, f.is_mandatory, f.is_readonly,
         f.is_unique, f.is_custom, f.is_active, f.display_type,
         f.default_value, f.max_length, f.help_text, f.config,
         f.quick_create, f.mass_editable, f.searchable, f.is_customised
    FROM ipy_field f
    LEFT JOIN ipy_block lb ON lb.id = f.block_id
    LEFT JOIN ipy_block ab ON ab.module_id = associate_module AND ab.name = lb.name
   WHERE f.module_id = lead_module;

  INSERT INTO ipy_profile_module_perm (
    profile_id, module_id, can_view, can_create, can_edit, can_delete,
    can_export, can_import
  )
  SELECT profile_id, associate_module, can_view, can_create, can_edit,
         can_delete, can_export, can_import
    FROM ipy_profile_module_perm WHERE module_id = lead_module;

  INSERT INTO ipy_profile_field_perm (profile_id, field_id, permission)
  SELECT fp.profile_id, af.id, fp.permission
    FROM ipy_profile_field_perm fp
    JOIN ipy_field lf ON lf.id = fp.field_id AND lf.module_id = lead_module
    JOIN ipy_field af ON af.module_id = associate_module AND af.name = lf.name;

  INSERT INTO ipy_module_sharing (module_id, access)
  SELECT associate_module, access FROM ipy_module_sharing WHERE module_id = lead_module;

  INSERT INTO ipy_picklist_dependency (
    module_id, source_field, target_field, mapping, is_active
  )
  SELECT associate_module, source_field, target_field, mapping, is_active
    FROM ipy_picklist_dependency WHERE module_id = lead_module;

  INSERT INTO ipy_layout (
    module_id, name, type, is_default, is_active, config, sequence,
    is_customised
  )
  SELECT associate_module, name, type, is_default, is_active, config,
         sequence, is_customised
    FROM ipy_layout WHERE module_id = lead_module;

  INSERT INTO ipy_view (
    module_id, name, description, is_default, is_public, is_system,
    columns, filter, sort_by, sort_dir, display_mode, group_by,
    show_metrics, sequence, is_active
  )
  SELECT associate_module, 'All Associates', 'Every associate', true,
         true, true, columns, '{"logic":"AND","conditions":[]}'::jsonb,
         sort_by, sort_dir, display_mode, group_by, show_metrics,
         0, true
    FROM ipy_view
   WHERE module_id = lead_module AND is_default
   ORDER BY is_system DESC, sequence, id
   LIMIT 1;
END $$;

CREATE TEMP TABLE ipy_associate_moves ON COMMIT DROP AS
SELECT r.id
  FROM ipy_record r
  JOIN ipy_e_leads l ON l.record_id = r.id
 WHERE r.module_name = 'leads'
   AND lower(btrim(l.contact_type)) IN ('dealer', 'builder');
CREATE UNIQUE INDEX ON ipy_associate_moves (id);

-- The cloned table has the exact same columns in the exact same order.
INSERT INTO ipy_e_associates
SELECT l.* FROM ipy_e_leads l JOIN ipy_associate_moves m ON m.id = l.record_id;

UPDATE ipy_record r
   SET module_id = (SELECT id FROM ipy_module WHERE name = 'associates'),
       module_name = 'associates'
  FROM ipy_associate_moves m
 WHERE r.id = m.id;

UPDATE ipy_call c SET record_module = 'associates'
  FROM ipy_associate_moves m WHERE c.record_id = m.id AND c.record_module = 'leads';
UPDATE ipy_conversation c SET record_module = 'associates'
  FROM ipy_associate_moves m WHERE c.record_id = m.id AND c.record_module = 'leads';
UPDATE ipy_e_activities_archive a SET related_module = 'associates'
  FROM ipy_associate_moves m WHERE a.related_to = m.id AND a.related_module = 'leads';
UPDATE ipy_audit a SET module_name = 'associates'
  FROM ipy_associate_moves m WHERE a.record_id = m.id AND a.module_name = 'leads';
UPDATE ipy_ai_insight i SET module_name = 'associates'
  FROM ipy_associate_moves m WHERE i.record_id = m.id AND i.module_name = 'leads';

-- These tags were already attached to the moved records. Keep them offered
-- in Associates without broadening every lead-only tag to a new module.
UPDATE ipy_tag t SET modules = array_append(t.modules, 'associates')
 WHERE 'leads' = ANY(t.modules) AND NOT ('associates' = ANY(t.modules))
   AND EXISTS (
     SELECT 1 FROM ipy_tag_link x JOIN ipy_associate_moves m ON m.id = x.record_id
      WHERE x.tag_id = t.id
   );

DELETE FROM ipy_e_leads l USING ipy_associate_moves m WHERE l.record_id = m.id;
