-- The last of site capture's old machinery.
--
-- Migration 060 removed the linked-phone WhatsApp; this removes what the capture
-- rebuild left behind. Shoot sessions bound a property to a window of time so
-- photos could be matched to it by their EXIF timestamps. The team uploads
-- straight into the property's OneDrive folder now, so there is nothing to
-- match: the folder is the answer the timestamps were being asked for.
--
-- The cull marks go with them. Culling is n8n's job now, after Finish, and a
-- column the CRM no longer writes is a column that will confuse whoever reads
-- it next.
ALTER TABLE ipy_attachment DROP COLUMN IF EXISTS cull_state;
ALTER TABLE ipy_attachment DROP COLUMN IF EXISTS cull_reason;
ALTER TABLE ipy_attachment DROP COLUMN IF EXISTS shoot_session_id;
DROP TABLE IF EXISTS ipy_shoot_session CASCADE;
