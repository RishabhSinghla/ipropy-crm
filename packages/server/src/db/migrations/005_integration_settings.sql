-- ===========================================================================
-- iPropy CRM — 005: generic web-form capture key as a configurable integration
--
-- Every other credential a provider needs (WhatsApp, Twilio, SMTP, Anthropic,
-- lead-source webhook keys) already has a row in ipy_integration. The generic
-- web-form capture endpoint's shared secret (WEBFORM_PUBLIC_KEY) did not, so
-- it could only ever be set via .env. Adding it here lets the admin panel
-- regenerate it like every other credential, without editing the codebase.
--
-- Safe to run on a fresh database and idempotent.
-- ===========================================================================

INSERT INTO ipy_integration (provider, kind, label)
VALUES ('webform', 'lead_source', 'Generic Web Form Capture')
ON CONFLICT (provider, label) DO NOTHING;
