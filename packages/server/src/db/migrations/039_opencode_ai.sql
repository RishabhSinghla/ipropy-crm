-- OpenCode Zen is an additional AI route, not a replacement for the others.
-- Its free models are useful for high-volume CRM text work while Gemini remains
-- available for vision and Groq for speech. ON CONFLICT preserves every setting
-- already configured in production.

INSERT INTO ipy_integration (provider, kind, label, config)
VALUES (
  'ai_opencode',
  'ai',
  'OpenCode Zen',
  '{"model":"nemotron-3-ultra-free","fastModel":"deepseek-v4-flash-free"}'::jsonb
)
ON CONFLICT (provider, label) DO NOTHING;
