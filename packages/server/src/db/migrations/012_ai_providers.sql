-- ===========================================================================
-- iPropy CRM — 012: alternative LLM providers
--
-- The AI layer only knew how to talk to Anthropic, so with no ANTHROPIC_API_KEY
-- every AI feature ran permanently on its fallback rule engine. Each provider
-- below speaks the OpenAI chat-completions shape, so one adapter reaches all of
-- them, and several have a free tier — which is the point: an operator with no
-- LLM budget can still run lead scoring, drafting, matching and the assistant.
--
-- Only rows are added here; picking between them is core/settings/integrations.ts.
-- Idempotent and safe on a fresh database.
-- ===========================================================================

INSERT INTO ipy_integration (provider, kind, label, config) VALUES
  ('ai_gemini',     'ai', 'Google Gemini',            '{"model":"gemini-2.5-flash","fastModel":"gemini-2.5-flash-lite"}'::jsonb),
  ('ai_groq',       'ai', 'Groq',                     '{"model":"llama-3.3-70b-versatile","fastModel":"llama-3.1-8b-instant"}'::jsonb),
  ('ai_openrouter', 'ai', 'OpenRouter',               '{"model":"openrouter/free","fastModel":"openrouter/free"}'::jsonb),
  ('ai_openai',     'ai', 'OpenAI-compatible',        '{"model":"gpt-4o-mini","fastModel":"gpt-4o-mini"}'::jsonb),
  ('ai_ollama',     'ai', 'Ollama (local)',           '{"model":"llama3.1","fastModel":"llama3.1"}'::jsonb)
ON CONFLICT (provider, label) DO NOTHING;
