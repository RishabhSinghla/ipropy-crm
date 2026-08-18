-- When the folders live on somebody's Mac, the CRM cannot make them.
--
-- The CRM's own folder worker provisions through the storage driver, which is
-- R2 — so it marks a property ready the moment R2 has the tree, and n8n (the
-- only thing that can write to the synced OneDrive folder) never sees the
-- property as outstanding.
--
-- Reusing provisioned_driver for both would deadlock the two: n8n sets it to
-- 'onedrive', the CRM's worker sees a driver that is not its own and re-claims
-- it, forever. So the OneDrive copy gets its own timestamp, which only n8n
-- writes and nothing else reads for provisioning decisions.
ALTER TABLE ipy_property_storage
  ADD COLUMN IF NOT EXISTS onedrive_folder_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_property_storage_onedrive_pending
  ON ipy_property_storage (created_at)
  WHERE onedrive_folder_at IS NULL;
