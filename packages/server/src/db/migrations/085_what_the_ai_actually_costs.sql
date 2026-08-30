-- What the AI actually costs, in rupees, and what the log stops keeping.
--
-- `ipy_ai_log` has counted input and output tokens since it was built and has
-- never turned them into money. For a business running on a near-zero AI budget
-- that is the one number that matters, and "1.2 million tokens" is not it.
--
-- Stored in paise as an integer. Money in a floating-point column is how a total
-- comes out as ₹0.30000000000000004, and summing thousands of fractions of a
-- rupee is precisely where that shows up.
--
-- The second half of this is a privacy fix. `prompt_summary` kept the first 500
-- characters of every prompt, and a prompt is built out of the customer's own
-- notes, their messages and their call transcripts. So the log quietly became a
-- second copy of customer data, in a table nobody thinks of as holding any, with
-- no retention rule and no way to honour a deletion request. India's DPDP Act
-- has a view about that.
--
-- It stays available because it is genuinely useful when a model starts
-- answering badly and somebody needs to see what it was asked. But it is off
-- unless switched on, which is the opposite of how it shipped.

ALTER TABLE ipy_ai_log ADD COLUMN IF NOT EXISTS cost_paise BIGINT NOT NULL DEFAULT 0;

-- The usage screen groups by feature over 30 days; without this it is a full
-- scan of every AI call ever made, which grows without limit.
CREATE INDEX IF NOT EXISTS ipy_ai_log_created_feature_idx ON ipy_ai_log (created_at DESC, feature);

INSERT INTO ipy_setting (key, value, category, label, description)
VALUES (
  'ai.log_prompt_text', 'false'::jsonb, 'ai',
  'Keep a copy of what was sent to the AI',
  'Off by default. A prompt is built from the customer''s own notes, messages and call '
  || 'transcripts, so keeping one puts a second copy of their words in the activity log. '
  || 'Switch it on for a day when a model starts answering badly and you need to see what it '
  || 'was asked, then switch it off again.'
)
ON CONFLICT (key) DO NOTHING;

-- Clear what was already kept. It was collected without the switch existing, so
-- there is no version of this where holding on to it is the right call.
UPDATE ipy_ai_log SET prompt_summary = NULL WHERE prompt_summary IS NOT NULL;
