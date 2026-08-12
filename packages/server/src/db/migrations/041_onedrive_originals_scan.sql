-- Files may be added from the OneDrive phone app, outside an iPropy HTTP
-- request. Remember Graph's item id so repeated background scans import each
-- original exactly once and then feed it into the ordinary media queue.

ALTER TABLE ipy_property_storage ADD COLUMN IF NOT EXISTS last_scanned_at TIMESTAMPTZ;
ALTER TABLE ipy_property_storage ADD COLUMN IF NOT EXISTS last_scan_error TEXT;

ALTER TABLE ipy_attachment ADD COLUMN IF NOT EXISTS source_external_id TEXT UNIQUE;

CREATE INDEX IF NOT EXISTS idx_property_storage_scan_due
  ON ipy_property_storage (last_scanned_at NULLS FIRST)
  WHERE status = 'ready' AND provisioned_driver = 'onedrive';
