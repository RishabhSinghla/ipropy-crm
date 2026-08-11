-- Transcription state for a visit's voice note.
--
-- Kept on the session rather than in a queue table because there are ten of
-- these a day, not ten thousand: a polled column is the whole mechanism, and a
-- job table would be more moving parts than the problem has.
--
-- Attempts are counted so a recording the provider will never accept — a codec
-- it does not support, a clip of pure wind noise — stops being retried every
-- minute forever. The audio is kept either way; a failed transcription still
-- leaves somebody a recording they can play.

ALTER TABLE ipy_shoot_session
  ADD COLUMN IF NOT EXISTS voice_status TEXT NOT NULL DEFAULT 'none'
    CHECK (voice_status IN ('none', 'pending', 'done', 'failed'));

ALTER TABLE ipy_shoot_session
  ADD COLUMN IF NOT EXISTS voice_attempts INTEGER NOT NULL DEFAULT 0;

ALTER TABLE ipy_shoot_session
  ADD COLUMN IF NOT EXISTS voice_error TEXT;

-- The worker's only query: the next few notes waiting to be transcribed.
CREATE INDEX IF NOT EXISTS idx_shoot_session_voice_pending
  ON ipy_shoot_session(created_at)
  WHERE voice_status = 'pending';
