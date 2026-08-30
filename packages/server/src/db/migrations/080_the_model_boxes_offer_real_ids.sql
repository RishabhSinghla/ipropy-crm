-- The model boxes now offer the models that can do the job, so stop telling
-- people to go and find an id somewhere else.
--
-- Every one of these descriptions ended with a version of "paste any id from
-- openrouter.ai/models". That is how four of the eight shipped defaults came to
-- be wrong, in four different ways: an id typed in by hand, with nothing to
-- check it against until a feature failed weeks later in front of a customer.
--
-- Each box now lists what OpenRouter actually serves for that job — music
-- models for music, embedding models for search — free ones first, with what
-- the rest cost in rupees. The box stays free text, because a list goes stale
-- the day a model is retired and being unable to type the id that works would
-- be worse than being offered one that does not.
--
-- Transcription is deliberately the exception. It does not go to OpenRouter at
-- all; it goes to the speech-to-text service in Admin → Integrations, so there
-- is no list to offer and offering one would point at the wrong provider.

UPDATE ipy_setting
   SET description = replace(
         description,
         'Paste any id from openrouter.ai/models.',
         'The box lists the ones that can do this job.'
       )
 WHERE key LIKE 'ai_models.%'
   AND description LIKE '%Paste any id from openrouter.ai/models.%';

UPDATE ipy_setting
   SET description = replace(
         description,
         'Paste any id from openrouter.ai/models',
         'The box lists the ones that can do this job'
       )
 WHERE key LIKE 'ai_models.%'
   AND description LIKE '%Paste any id from openrouter.ai/models%';
