-- The official WhatsApp Business route, alongside the agent-linked one.
--
-- Almost nothing new is needed, and that is the point: `ipy_conversation` and
-- `ipy_message` already carry a channel, a handle, an assigned agent, the
-- 24-hour window, provider message ids and sent/delivered/read. The official
-- route is another way those rows get written, not a second set of tables —
-- one contact, one communication history, which is the owner's primary rule.
--
-- Two things are genuinely new.

-- 1. Which road a message took.
--
-- The business number and a rep's own linked number are different phones with
-- different rules, and when both exist a reader has to be able to tell which
-- one a customer was answered from. Null on every historical row, because they
-- predate the question and guessing an answer for them would be inventing it.
ALTER TABLE ipy_message ADD COLUMN IF NOT EXISTS route TEXT;

-- 2. What has already been seen.
--
-- Every provider retries a webhook it did not hear a 200 for, and Meta retries
-- for days. Without a memory of deliveries the same customer message lands
-- twice, the agent is notified twice, and a campaign's delivery counts drift.
-- The dedupe lives here rather than as a unique index on `ipy_message`,
-- deliberately: the messages table already holds rows from a removed
-- integration whose provider ids nobody can vouch for, and a unique index that
-- fails to build on live data is a migration that cannot be applied.
CREATE TABLE IF NOT EXISTS ipy_wa_webhook_event (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    TEXT NOT NULL,
  -- 'message' or 'status': the same provider message id arrives as both, and
  -- they are two different things to act on.
  kind        TEXT NOT NULL,
  event_key   TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, kind, event_key)
);

-- Pruned by date, so the table stays small without anybody remembering it.
CREATE INDEX IF NOT EXISTS idx_wa_webhook_event_age ON ipy_wa_webhook_event (received_at);
