-- Inbound email sync idempotency: a message-id is globally unique, so a
-- unique index on provider_id is the hard guard against a poll racing itself
-- (or being re-run) and importing the same message twice. Outbound rows that
-- were simulated never set provider_id; NULLs are distinct in a Postgres
-- unique index, so they are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS ipy_email_log_provider_id_uidx ON ipy_email_log (provider_id);
