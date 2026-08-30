-- Three things the AI did on its own, each now a switch an admin owns.
--
-- An outside review found all three. None was reckless, and all three were
-- decisions taken in code that should have been taken by the person whose
-- business it is. That is the "nothing hardcoded" rule, applied to behaviour
-- rather than to values.
--
-- 1 and 2. `AI-ARCHITECTURE.md` promises that nothing reaches a CRM field
-- without a person confirming it. Call analysis quietly filled blank fields and
-- set a follow-up date. In its defence it only ever wrote to a field that was
-- *empty*, never overwrote one, refused an implausible amount, and every write
-- landed in the record history tagged `ai_call_analysis`. So the care was there
-- and the switch was not. Both default to on, because that is how the CRM has
-- behaved and nothing about it is unsafe.
--
-- 3. The one that matters most, and the one to read twice before touching.
-- `getAiFallbackChain()` falls back to AI providers whose card is switched
-- **off**, reasoning that holding a working key and refusing to answer is worse.
-- The review is right that this is the wrong way round: switching a provider off
-- is a decision about who may see lead notes and call recordings, not a
-- preference.
--
-- It defaults to ON anyway, and that is deliberate rather than timid. The
-- OpenRouter card on this system is inactive while holding the key and the model
-- configuration, which is exactly the shape this fallback was written for.
-- Defaulting it off would silently switch off every AI feature in the product to
-- close a hole nobody is standing in. Switch it off after switching on every
-- provider you actually want used.

INSERT INTO ipy_setting (key, value, category, label, description)
VALUES
  ('ai_features.fill_fields_from_calls', 'true'::jsonb, 'ai_features',
   'Fill blank fields from a call',
   'After a call is transcribed, a budget or a locality the buyer said out loud goes into that '
   || 'field if it is empty. It never changes something already filled in, and every write shows '
   || 'in the record history.'),

  ('ai_features.follow_up_from_calls', 'true'::jsonb, 'ai_features',
   'Set the follow-up date from a call',
   '"Call me Tuesday" becomes a follow-up on Tuesday, without anybody typing it.'),

  ('ai.use_disabled_providers', 'true'::jsonb, 'ai',
   'Use a switched-off AI provider rather than fail',
   'When every AI provider you have switched on is failing, fall back to one that is switched off '
   || 'but still holds a working key. Leave this on and the CRM keeps answering; turn it off and '
   || '"off" means that company never sees a lead note or a call recording again. Turn it off once '
   || 'the providers you want used are switched on.')
ON CONFLICT (key) DO NOTHING;
