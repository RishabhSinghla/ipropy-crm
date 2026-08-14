-- ===========================================================================
-- iPropy CRM — 047: a proposed change can come from somewhere other than chat
--
-- `ipy_ai_action` was built for Ask iPropy: you type "mark Riya as qualified",
-- it plans the change, you confirm it. Two of its assumptions are specific to
-- that conversation and wrong for anything else.
--
-- `thread_id NOT NULL` assumes a chat thread exists. A proposal that comes out
-- of a finished phone call has no thread and never will.
--
-- `expires_at` defaulting to 30 minutes is right for a chat — you are looking
-- at the screen, you answer now or you have moved on. It is wrong for a call:
-- the rep is in a car, gets back to their desk in an hour, and finds the CRM
-- has thrown away the summary of the conversation they just had. The default
-- stays 30 minutes because most proposals are still chat; callers that know
-- better now set their own.
--
-- `origin` records which it was, because the two want different words on
-- screen — a chat proposal echoes what you asked for, a call proposal has to
-- explain itself to somebody who has not seen it before.
-- ===========================================================================

ALTER TABLE ipy_ai_action ALTER COLUMN thread_id DROP NOT NULL;

ALTER TABLE ipy_ai_action
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'ask_ipropy';

-- Everything that exists today came from the assistant, which is the default,
-- so no backfill is needed.

COMMENT ON COLUMN ipy_ai_action.origin IS
  'Where the proposal came from: ask_ipropy (a chat message) or call (a finished call''s analysis).';

-- Pending proposals are read per record when a page opens, which is the only
-- hot path this table has.
CREATE INDEX IF NOT EXISTS idx_ai_action_record_pending
  ON ipy_ai_action(record_id, created_at DESC) WHERE status = 'pending';
