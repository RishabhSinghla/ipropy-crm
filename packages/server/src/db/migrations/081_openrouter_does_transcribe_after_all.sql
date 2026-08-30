-- OpenRouter transcribes after all, so point the default at it.
--
-- Migration 079 moved transcription to the speech-to-text card on the stated
-- grounds that "OpenRouter is a chat gateway and does not transcribe". That is
-- false. It serves nineteen transcription models at POST /audio/transcriptions,
-- taking exactly the multipart shape 079 introduced.
--
-- The mistake is worth writing down because it will be made again otherwise:
-- the shipped id was checked against `/api/v1/models`, which is **chat-only**,
-- found to be absent, and concluded to be invented. Embeddings, rerank, speech
-- and transcription models are all absent from that list and all real. The list
-- that has them is `?output_modalities=transcription`, and the original default
-- `nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b` is the first entry in it.
--
-- What 079 got right stands: the request was JSON with the audio base64-encoded
-- where the endpoint wants a file part, and that alone is why every id failed.
-- Both providers take the same multipart shape, so one code path serves both.
--
-- Consequence for this CRM: the OpenRouter key is already saved, so transcription
-- works from now with no second signup. The speech-to-text card still wins when
-- it has a key, because filling that card in is a decision.
--
-- The id has to match whichever provider will receive it. Groq calls it
-- `whisper-large-v3-turbo`; OpenRouter calls the same model
-- `openai/whisper-large-v3-turbo`. So this only rewrites the id when the CRM is
-- actually going to OpenRouter, meaning no speech-to-text key is saved. An admin
-- who has set Groq up keeps the Groq name.

UPDATE ipy_setting
   SET value = '"openai/whisper-large-v3-turbo"'::jsonb
 WHERE key = 'ai_models.transcribe'
   AND value = '"whisper-large-v3-turbo"'::jsonb
   AND NOT EXISTS (
         SELECT 1 FROM ipy_integration
          WHERE provider = 'stt'
            AND coalesce(credentials->>'apiKey', config->>'apiKey', '') <> ''
       );

-- Say which provider the id has to match, because that is the one thing about
-- this box that is not obvious and the one thing that silently breaks it.
UPDATE ipy_setting
   SET description = 'Turns call recordings and voice notes into words. Handles Hindi and English '
     || 'mixed together. Goes to the Speech to text service under Admin → Integrations when one '
     || 'has a key, and to OpenRouter otherwise — so the id has to match whichever of those it '
     || 'will reach. The box lists OpenRouter''s. Groq drops the "openai/" from the front.'
 WHERE key = 'ai_models.transcribe';
