-- What the photos in a shoot are actually of.
--
-- Migration 036 gave somebody a screen full of nameless groups and asked which
-- property each one is. That works because they recognise their own pictures —
-- but four thumbnails at the top of a card is a memory test, and a backlog of
-- twenty groups from three days ago is a hard one.
--
-- A model that can look at the photos turns it into reading. "3 BHK, marble
-- flooring, modular kitchen, covered parking" beside a group is the difference
-- between recalling a Tuesday afternoon and recognising a floor.
--
-- What this deliberately is not: a source of truth. Nothing here is written to
-- the property record. A model can see a modular kitchen; it cannot see that
-- this is B-110 rather than B-112, and the moment a description is treated as a
-- fact instead of a hint, the whole point of asking a person is lost.

ALTER TABLE ipy_shoot_session
  ADD COLUMN IF NOT EXISTS vision JSONB NOT NULL DEFAULT '{}'::jsonb;

--   none     not looked at yet
--   pending  eligible, waiting for the worker
--   done     described
--   failed   the provider will not accept these, and retrying has stopped
--
-- Same shape as voice_status, and for the same reason: a handful of these a
-- day, so a polled column is the entire mechanism and a job table would be more
-- moving parts than the problem has.
ALTER TABLE ipy_shoot_session
  ADD COLUMN IF NOT EXISTS vision_status TEXT NOT NULL DEFAULT 'none'
    CHECK (vision_status IN ('none', 'pending', 'done', 'failed'));

-- Counted so a shoot the model will never accept — a burst of corrupt frames, a
-- provider whose model has no vision at all — stops being retried every minute
-- forever against a free tier's daily quota.
ALTER TABLE ipy_shoot_session
  ADD COLUMN IF NOT EXISTS vision_attempts INTEGER NOT NULL DEFAULT 0;

ALTER TABLE ipy_shoot_session
  ADD COLUMN IF NOT EXISTS vision_error TEXT;

-- The worker's only query: nameless shoots still waiting to be looked at.
-- Named ones are excluded because the description exists to help somebody name
-- the thing; once that is done it would be spending a quota to tell them
-- something they just told us.
CREATE INDEX IF NOT EXISTS idx_shoot_session_vision_pending
  ON ipy_shoot_session(started_at)
  WHERE vision_status IN ('none', 'pending') AND record_id IS NULL;
