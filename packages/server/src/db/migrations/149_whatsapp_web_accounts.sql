-- WhatsApp Web is a separate connector from Meta's official Cloud API.
-- It owns only explicitly linked CRM accounts; it never imports a phone's
-- historical/private chats.
CREATE TABLE IF NOT EXISTS ipy_whatsapp_web_account (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL,
  phone_number TEXT,
  display_name TEXT,
  auth_state_encrypted TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected'
    CHECK (status IN ('disconnected','connecting','qr','pairing','connected','error')),
  last_connected_at TIMESTAMPTZ,
  last_error TEXT,
  created_by UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_web_account_phone
  ON ipy_whatsapp_web_account(phone_number) WHERE phone_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_whatsapp_web_account_status
  ON ipy_whatsapp_web_account(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS ipy_whatsapp_web_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES ipy_whatsapp_web_account(id) ON DELETE CASCADE,
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info','warn','error')),
  event TEXT NOT NULL,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_web_log_account
  ON ipy_whatsapp_web_log(account_id, created_at DESC);

ALTER TABLE ipy_conversation
  ADD COLUMN IF NOT EXISTS whatsapp_web_account_id UUID REFERENCES ipy_whatsapp_web_account(id) ON DELETE SET NULL;
ALTER TABLE ipy_message
  ADD COLUMN IF NOT EXISTS whatsapp_web_account_id UUID REFERENCES ipy_whatsapp_web_account(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_message_whatsapp_web_account
  ON ipy_message(whatsapp_web_account_id, created_at DESC) WHERE whatsapp_web_account_id IS NOT NULL;

INSERT INTO ipy_integration (provider, kind, label)
VALUES ('whatsapp_web', 'messaging', 'WhatsApp Web (QR / pairing)')
ON CONFLICT (provider, label) DO NOTHING;
