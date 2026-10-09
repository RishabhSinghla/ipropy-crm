-- Row leases work through transaction-pooling proxies; session advisory locks
-- can remain on a different backend after a query or a server restart.
ALTER TABLE ipy_facebook_health ADD COLUMN worker_id UUID;
ALTER TABLE ipy_facebook_health ADD COLUMN worker_lease_until TIMESTAMPTZ;
