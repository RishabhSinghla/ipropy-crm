-- Two agents talking to one customer is two conversations, not one.
--
-- `ipy_conversation` has carried `UNIQUE (channel, handle)` since migration 003,
-- and it was right at the time: one business number, so one thread per person.
-- Agent-linked WhatsApp breaks that assumption — Sheetal's thread with a buyer
-- and Rahul's thread with the same buyer are two different conversations, held
-- on two different phones, and folding them into one row would interleave their
-- messages and make "who said this" unanswerable.
--
-- The database found this rather than a review: the insert failed with
-- `duplicate key value violates unique constraint
-- ipy_conversation_channel_handle_key` the first time a second agent messaged
-- a contact the first had already spoken to.
--
-- Two partial indexes rather than one loose one. A plain
-- `UNIQUE (channel, handle, wa_account_id)` would treat every NULL account as
-- distinct, so email and SMS would stop being deduplicated at all — which is
-- the behaviour migration 003 was protecting.
ALTER TABLE ipy_conversation DROP CONSTRAINT IF EXISTS ipy_conversation_channel_handle_key;

-- Everything that is not an agent's linked phone keeps exactly the old rule.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_channel_handle
  ON ipy_conversation (channel, handle)
  WHERE wa_account_id IS NULL;

-- One thread per person per linked account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_channel_handle_account
  ON ipy_conversation (channel, handle, wa_account_id)
  WHERE wa_account_id IS NOT NULL;
