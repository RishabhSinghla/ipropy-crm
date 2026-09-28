-- A status change must never narrow, clear, reveal, or require Lost Reason.
-- Keep existing Lost Reason values and the field itself; only remove rules.
-- Apply to every module, including custom modules and Associates.
DELETE FROM ipy_picklist_dependency d
USING ipy_module m
WHERE d.module_id = m.id
  AND (
    d.source_field = m.pipeline_field
    OR EXISTS (
      SELECT 1 FROM ipy_field source
      WHERE source.module_id = m.id AND source.name = d.source_field
        AND (source.column_name = 'status'
             OR right(source.config->>'picklist', 7) = '_status')
    )
    OR EXISTS (
      SELECT 1 FROM ipy_field target
      WHERE target.module_id = m.id AND target.name = d.target_field
        AND target.config->>'picklist' = 'lost_reason'
    )
  );

-- Older admins could also encode the same coupling as field conditions.
-- Lost Reason is optional and always available, irrespective of status.
UPDATE ipy_field
SET config = config - 'requiredWhen' - 'visibleWhen',
    updated_at = now()
WHERE config->>'picklist' = 'lost_reason'
  AND (config ? 'requiredWhen' OR config ? 'visibleWhen');
