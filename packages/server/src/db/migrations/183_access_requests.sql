-- A rep asking the owner of a record for access to it.
--
-- 3 October 2026, the owner: "if the agent/user search the any thing, then
-- system will display the record name on the screen and if agent want to access
-- the display record, he can ask to actual owner of record for the permission
-- to assigned him, Now The actual user can change the owner of record."
--
-- The request is a row rather than a message so that the state is a fact both
-- people can read: a rep can see they already asked, and the owner can see what
-- is waiting. Granting it is an ordinary reassignment through recordService, so
-- permissions, validation, workflows and the audit trail all apply unchanged —
-- nothing here is a second way to change who owns a record.
CREATE TABLE IF NOT EXISTS ipy_access_request (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id     uuid NOT NULL REFERENCES ipy_record(id) ON DELETE CASCADE,
  module_name   text NOT NULL,
  requested_by  uuid NOT NULL REFERENCES ipy_user(id) ON DELETE CASCADE,
  -- Who it was addressed to when it was made. Kept even after a reassignment,
  -- because "who did we ask" is the question somebody comes back with.
  owner_id      uuid REFERENCES ipy_user(id) ON DELETE SET NULL,
  note          text,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'granted', 'declined')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  decided_by    uuid REFERENCES ipy_user(id) ON DELETE SET NULL
);

-- One open request per person per record. Asking twice is not a second
-- request; it is the same person still waiting, and a queue full of duplicates
-- is how an owner stops reading the queue.
CREATE UNIQUE INDEX IF NOT EXISTS uq_access_request_open
  ON ipy_access_request (record_id, requested_by)
  WHERE status = 'pending';

-- What the owner's own queue reads.
CREATE INDEX IF NOT EXISTS idx_access_request_owner
  ON ipy_access_request (owner_id, status, created_at DESC);
