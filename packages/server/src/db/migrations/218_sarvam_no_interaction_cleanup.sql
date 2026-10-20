-- Sarvam answers `NO_INTERACTION_ID` for an attempt that never became a conversation (busy, no answer, a refusal).
-- The first reconciliation took that for a real conversation id and gave 36 calls a recording link that plays nothing.
UPDATE ipy_call
   SET sarvam_interaction_id = NULL,
       recording_url = CASE WHEN recording_url LIKE 'sarvam:%' THEN NULL ELSE recording_url END
 WHERE sarvam_interaction_id IS NOT NULL AND sarvam_interaction_id !~ '^[0-9]{8}/.+';
