-- Ready-to-configure Zapier lead capture and Google RCS for Business.
INSERT INTO ipy_integration (provider, kind, label)
VALUES
  ('zapier', 'lead_source', 'Zapier Lead Capture'),
  ('google_rcs', 'messaging', 'Google RCS for Business')
ON CONFLICT (provider, label) DO NOTHING;

ALTER TABLE ipy_conversation DROP CONSTRAINT IF EXISTS ipy_conversation_channel_check;
ALTER TABLE ipy_conversation ADD CONSTRAINT ipy_conversation_channel_check
  CHECK (channel IN ('whatsapp','sms','email','webchat','rcs'));
