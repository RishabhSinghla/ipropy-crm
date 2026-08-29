-- Transcription now goes to the speech-to-text provider, so it needs its model.
--
-- It used to go to OpenRouter with every other media call and was wrong twice
-- over: OpenRouter is a chat gateway and does not transcribe, and the request
-- was JSON with the audio base64-encoded when every OpenAI-compatible
-- transcription endpoint takes multipart form data with a file part. So the
-- settings box reported "it could not read the audio" whatever id was in it, and
-- no id would ever have fixed it.
--
-- Meanwhile the `stt` integration row already held the right address and key —
-- Groq's Whisper, which he already pays nothing for — and nothing that
-- transcribes had ever read it.
--
-- The model is named here rather than on the integration, like every other AI
-- job: one box holds the model, the integration holds only where to send it.
-- Two places holding one model id is the pattern this CRM keeps getting wrong.
--
-- Only replaces the shipped default. An id an admin chose themselves is theirs,
-- even if it is one that cannot work — telling them so is the Test button's job,
-- and it does that properly now.

UPDATE ipy_setting
   SET value = '"whisper-large-v3-turbo"'::jsonb,
       description = 'Turns call recordings and voice notes into words. Handles Hindi and English '
         || 'mixed together. Sent to whichever speech-to-text service is set up under '
         || 'Admin → Integrations, not to OpenRouter — transcription is not a chat model. '
         || 'whisper-large-v3-turbo on Groq is free and handles Indian English well.'
 WHERE key = 'ai_models.transcribe'
   AND value = '"nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b"'::jsonb;
