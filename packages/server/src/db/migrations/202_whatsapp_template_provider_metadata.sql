ALTER TABLE ipy_whatsapp_template
  ADD COLUMN IF NOT EXISTS provider_source TEXT,
  ADD COLUMN IF NOT EXISTS provider_row_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ipy_whatsapp_template_provider_status
  ON ipy_whatsapp_template(provider_source, status, provider_updated_at DESC);
