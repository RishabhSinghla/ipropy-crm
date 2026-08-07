-- Channel Partner portal identity: a user account may be linked to exactly one
-- channel_partner record. The link gives that user the partner's portal data
-- (their own submissions, bookings, commissions) without loosening the portal
-- profile's module permissions — every portal read is scoped by this id, never
-- by a client-supplied value. ON DELETE SET NULL so deactivating a partner
-- record does not take down the user account.
ALTER TABLE ipy_user ADD COLUMN IF NOT EXISTS channel_partner_id uuid NULL REFERENCES ipy_record(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ipy_user_channel_partner ON ipy_user (channel_partner_id);
