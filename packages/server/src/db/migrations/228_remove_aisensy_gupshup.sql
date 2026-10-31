-- AiSensy and Gupshup were removed as WhatsApp providers (31 October 2026, owner's
-- instruction). Only their two settings cards go, and only when nobody ever set
-- them up: a card that is switched on or holds a key, a number or a token is
-- left alone, so no one's credentials are deleted. Messages, conversations and
-- templates are untouched; any record that still names one of these providers
-- simply reads as plain WhatsApp.
DELETE FROM ipy_integration
WHERE provider IN ('whatsapp_aisensy', 'whatsapp_gupshup')
  AND is_active = false
  AND credentials = '{}'::jsonb
  AND config = '{}'::jsonb;
