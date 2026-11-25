-- WhatsApp was removed from the CRM: chats, the business API, OpenWA linked numbers, drip, templates,
-- campaigns and the buttons on records (owner's instruction, 25 November 2026).
-- Only the three WhatsApp settings cards go. Every conversation, message, template, campaign, consent
-- row and file the CRM kept stays in its table, so a later rebuild starts from data.
DELETE FROM ipy_integration WHERE provider IN ('whatsapp_meta', 'whatsapp_whatsmarketing', 'whatsapp_openwa');
