-- The QR-code WhatsApp card goes, with the road it belonged to.
--
-- Migration `149` seeded an integration card called "WhatsApp Web (QR /
-- pairing)" for the linked-device mechanism: a rep scans a code with their own
-- phone and the CRM sends as them. That is against WhatsApp's terms and risks
-- the rep's own number, and the owner asked for the whole QR road to be
-- removed on 19 September 2026. The official business route — Meta direct or
-- through AiSensy, Gupshup or another reseller — is the only WhatsApp road now.
--
-- The row is what makes a card appear in Admin → Integrations, so deleting it
-- is what takes the card off the screen. Nothing in the code has read
-- `whatsapp_web` since the linked-device build was removed, so nothing loses a
-- setting it was using.
DELETE FROM ipy_integration WHERE provider = 'whatsapp_web';

-- `ipy_whatsapp_web_account` and its log are deliberately NOT dropped, in
-- keeping with every other removal here: a table that holds rows somebody once
-- created is kept, and a migration that drops data cannot be undone.
