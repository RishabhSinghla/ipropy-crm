-- Archive is retention, never deletion. No expiry or purge job is attached.
ALTER TABLE ipy_record ADD COLUMN IF NOT EXISTS lost_archive_due_at timestamptz;
ALTER TABLE ipy_record ADD COLUMN IF NOT EXISTS archived_at timestamptz;
CREATE INDEX IF NOT EXISTS ipy_record_lost_archive_due ON ipy_record(lost_archive_due_at)
  WHERE lost_archive_due_at IS NOT NULL AND archived_at IS NULL AND is_deleted = false;
CREATE INDEX IF NOT EXISTS ipy_record_archive_module ON ipy_record(module_id, archived_at)
  WHERE archived_at IS NOT NULL AND is_deleted = false;

UPDATE ipy_unit_master SET label = CASE value WHEN 'sqyd' THEN 'Sq. Yd.'
  WHEN 'sqft' THEN 'Sq. Ft.' WHEN 'sqm' THEN 'Sq. Mtr.' ELSE label END, updated_at=now()
WHERE kind='area' AND value IN ('sqyd','sqft','sqm');
