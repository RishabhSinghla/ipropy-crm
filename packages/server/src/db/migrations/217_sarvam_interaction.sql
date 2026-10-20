-- 20 October 2026, the owner: connect the Sarvam AI caller end to end.
--
-- Sarvam's finished-call webhook carries an `interaction_id` (the conversation) beside the `attempt_id`
-- (the dial), and every recording, transcript and analytics row is addressed by it. The CRM kept only the
-- attempt, so 76 completed AI conversations had a transcript and nothing else: no recording to hear, no way
-- to ask Sarvam about them again. These columns keep the three facts a later look needs.
ALTER TABLE ipy_call
  ADD COLUMN IF NOT EXISTS sarvam_interaction_id TEXT,
  ADD COLUMN IF NOT EXISTS sarvam_app_id         TEXT,
  ADD COLUMN IF NOT EXISTS sarvam_meta           JSONB;

CREATE INDEX IF NOT EXISTS idx_call_sarvam_interaction ON ipy_call (sarvam_interaction_id) WHERE sarvam_interaction_id IS NOT NULL;
