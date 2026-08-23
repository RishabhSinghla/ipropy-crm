-- Which model does what, how this business sounds, and one switch per feature.
--
-- Everything below was a constant in a TypeScript file an hour ago. That is a
-- promise nobody will ever want to change it, and models on OpenRouter are
-- replaced every few weeks. A better vision model at half the price appearing
-- on a Tuesday should be a copy and a paste.
--
-- The settings screen renders whatever is in this table, typed from the stored
-- value, so adding a row here is the whole job — there is no second place to
-- register it. See `admin/SettingsAdmin.tsx`.
--
-- Every one of these has a fallback in code. A blank box, a nonsense box or a
-- database that will not answer all land on the value the CRM shipped with, so
-- a typo can slow a feature down and never switch it off.

INSERT INTO ipy_setting (key, value, category, label, description) VALUES
  ('ai_models.vision', '"xiaomi/mimo-v2.5"'::jsonb, 'ai_models',
   'Read photos and video',
   'Looks at property photographs and watches the walkthrough. Must be a model that accepts images. Paste any id from openrouter.ai/models.'),
  ('ai_models.copy', '"xiaomi/mimo-v2.5"'::jsonb, 'ai_models',
   'Write listing copy',
   'Writes the title, description, captions and the voiceover script. Text only, so a cheaper model is fine here.'),
  ('ai_models.speech', '"fish-audio/s2.1-pro-free:free"'::jsonb, 'ai_models',
   'Voiceover',
   'Turns the script into a voice for the property videos. The default is free.'),
  ('ai_models.music', '"google/lyria-3-clip-preview"'::jsonb, 'ai_models',
   'Music',
   'Writes the backing track. Charged per clip, and the only part of a property video that costs anything.'),
  ('ai_models.transcribe', '"nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b"'::jsonb, 'ai_models',
   'Transcribe recordings',
   'Turns call recordings and voice notes into words. Handles Hindi and English mixed together. About one rupee an hour of audio.'),
  ('ai_models.embed', '"nvidia/nemotron-3-embed-1b:free"'::jsonb, 'ai_models',
   'Search',
   'Powers search by meaning across leads, notes, messages and calls. Changing this re-indexes over the following hour.'),
  ('ai_models.rerank', '"nvidia/llama-nemotron-rerank-vl-1b-v2:free"'::jsonb, 'ai_models',
   'Reorder results',
   'Puts search results in the right order for the question that was asked.'),
  ('ai_models.video', '"bytedance/seedance-2.0-mini"'::jsonb, 'ai_models',
   'Generate video',
   'Only used for a single opening clip, and only when that is switched on below. Charged per second.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO ipy_setting (key, value, category, label, description) VALUES
  ('house_style.never_mention',
   '"Furniture, fittings, appliances, views, greenery or finishes that are not visible in the photograph. Never guess a floor number, a direction, an area or a price. An empty room is an empty room and saying so is correct."'::jsonb,
   'house_style', 'Never mention',
   'The rule that keeps every listing honest. Buyers walk into the actual room, so nothing may be described that is not in the photograph. Emptying this box restores the default rather than removing it.'),
  ('house_style.caption_tone',
   '"Sounds like a person, not a brochure. Indian English. One emoji at most. Never more than five lines."'::jsonb,
   'house_style', 'How captions should sound',
   'Applies to Instagram, Facebook and WhatsApp captions everywhere in the CRM.'),
  ('house_style.voice_language',
   '"Hinglish. Natural spoken Hindi-English mixing, the way a Delhi NCR property consultant talks to a client. Written in Latin script, not Devanagari."'::jsonb,
   'house_style', 'Voiceover language',
   'How the voice on your property videos speaks.'),
  ('house_style.music_brief',
   '"Calm, elegant, understated instrumental for a luxury property tour. Warm piano or soft strings with a light steady pulse. No drums that dominate, no build to a drop, nothing dramatic. It should sit under a speaking voice."'::jsonb,
   'house_style', 'Music brief',
   'What the backing track on a property video should sound like.'),
  ('house_style.sign_off',
   '"Message us for the floor plan and a site visit."'::jsonb,
   'house_style', 'How everything ends',
   'The closing line on captions, voiceovers and the end card of every video.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO ipy_setting (key, value, category, label, description) VALUES
  ('ai_features.photo_culling', 'true'::jsonb, 'ai_features',
   'Hold back weak photos',
   'The naming pass already scores every photograph out of ten. Below the score set below, a photo stays in RAW-UPLOADS and is not published anywhere.'),
  ('media.photo_score_floor', '4'::jsonb, 'ai_features',
   'Lowest photo score to publish',
   'Out of ten. Four holds back the blurred, the very dark and the ones pointing at a wall. Zero publishes everything.'),
  ('ai_features.voice_notes', 'true'::jsonb, 'ai_features',
   'Voice notes on a lead',
   'A microphone on the notes panel. Speak in Hinglish and it writes the note for you to check and save.'),
  ('ai_features.duplicate_suggestions', 'true'::jsonb, 'ai_features',
   'Spot the same person twice',
   'Suggests a merge when a new lead looks like one you already have. It only ever suggests; nothing merges on its own.'),
  ('ai_features.document_reading', 'true'::jsonb, 'ai_features',
   'Read uploaded documents',
   'Pulls dates, amounts and numbers out of agreements and certificates, and makes floor plans findable by what is drawn on them.'),
  ('ai_features.first_reply', 'true'::jsonb, 'ai_features',
   'Draft the first reply',
   'A new enquiry arrives with a WhatsApp already written, waiting for somebody to tap send. It never sends on its own.'),
  ('ai_features.reply_suggestions', 'true'::jsonb, 'ai_features',
   'Suggest replies in the Inbox',
   'Three suggested answers under each incoming message.'),
  ('ai_features.morning_brief', 'true'::jsonb, 'ai_features',
   'Morning brief',
   'Each person gets their day at 9am as a notification on their phone.'),
  ('ai_features.video_generation', 'false'::jsonb, 'ai_features',
   'Generate an opening clip',
   'One short generated shot at the front of a property reel. The only AI feature here that costs real money, roughly six rupees a property, and the only one that puts a frame on screen nobody photographed. Off by default.')
ON CONFLICT (key) DO NOTHING;
