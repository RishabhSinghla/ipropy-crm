-- Exotel, Twilio Voice, Ollama and OpenCode Zen, removed.
--
-- Four cards on Admin → Integrations, each asking for credentials, none of them
-- able to do anything for this business:
--
--   * **Exotel and Twilio Voice** are cloud telephony — dialling from the
--     browser, inbound IVR routing, recording callbacks. Neither was ever
--     configured. Calls here are made on a handset and come back through the
--     paired Android app, which is untouched and is the real feature.
--     Their webhook endpoints went with them: a public, signature-checked
--     surface kept alive for something nobody had switched on.
--
--   * **Ollama** needs a model server on the same machine as the CRM. That is
--     a laptop in development and a Render container in production, where
--     nothing is listening on 11434.
--
--   * **OpenCode Zen** answered `Model is unavailable` on every call, including
--     the Test button, with a key saved.
--
-- The rows go too, or the seed's own `is_active` state and saved credentials
-- sit in the database for providers no code can read — and a stored API key
-- that nothing will ever use is a secret with no owner.
--
-- Call history is **not** touched. `ipy_call` keeps every call already logged,
-- whichever way it arrived.

DELETE FROM ipy_integration WHERE provider IN ('twilio', 'exotel', 'ai_ollama', 'ai_opencode');

-- A workflow step that dialled through the cloud provider cannot run any more.
-- Left in place it would fail silently on every matching trigger, which is
-- worse than being gone: the rule would still look armed.
-- The column is `type`, not `action` — checked against the table rather
-- than assumed, which is the 42703 this repo keeps rediscovering.
DELETE FROM ipy_workflow_task WHERE type = 'trigger_call';
