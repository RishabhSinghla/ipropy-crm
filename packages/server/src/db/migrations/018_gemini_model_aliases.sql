-- ===========================================================================
-- iPropy CRM — 018: move Gemini onto alias models
--
-- 012 seeded `gemini-2.5-flash` / `gemini-2.5-flash-lite`. Google has since
-- retired both for newly created keys, which returns
--   404 "This model is no longer available to new users"
-- — indistinguishable, from the admin panel, from a bad API key. Pinning a
-- version means re-learning that every time Google rotates.
--
-- `gemini-flash-latest` and `gemini-flash-lite-latest` are aliases that follow
-- whatever the current flash model is, so this does not recur.
--
-- Only rewrites rows still holding the retired defaults; an admin who has
-- deliberately chosen a model keeps it.
-- ===========================================================================

UPDATE ipy_integration
SET config = jsonb_set(
      jsonb_set(config, '{model}', '"gemini-flash-latest"'::jsonb, true),
      '{fastModel}', '"gemini-flash-lite-latest"'::jsonb, true),
    updated_at = now()
WHERE provider = 'ai_gemini'
  AND config->>'model' IN ('gemini-2.5-flash', 'gemini-1.5-flash');
