-- ===========================================================================
-- iPropy CRM — 014: brand positioning line and social links
--
-- Two related things the team asked for:
--
--  * A one-line brand statement ("Builder Floor = iPropy") surfaced wherever
--    the product speaks: sign-in, the sidebar, the installed app's name.
--  * One-click links to the company's own social accounts from inside the CRM,
--    so nobody has to go hunting for the Instagram handle to reply to a comment.
--
-- Both are settings rather than constants in the code, for a practical reason:
-- the URLs below were found by public search, not supplied by the business, and
-- there is more than one plausible iPropy account (both @ipropy_official and
-- @ipropy.floors exist). An admin must be able to correct or delete any of them
-- in the UI without a deploy — so these are seeded as a starting point, not as
-- verified fact.
--
-- Idempotent: ON CONFLICT DO NOTHING, so re-running never overwrites whatever
-- the admin has since corrected.
-- ===========================================================================

INSERT INTO ipy_setting (key, value, category, label, description) VALUES
  ('brand.tagline', '"Builder Floor = iPropy"'::jsonb, 'brand',
   'Brand line', 'Shown on the sign-in screen, under the sidebar logo, and as the installed app''s description.'),

  ('social.links', '[
     {"platform":"website",  "label":"Website",   "url":"https://www.ipropy.com"},
     {"platform":"instagram","label":"Instagram", "url":"https://www.instagram.com/ipropy_official/"},
     {"platform":"facebook", "label":"Facebook",  "url":"https://www.facebook.com/ipropy/"},
     {"platform":"x",        "label":"X",         "url":"https://x.com/iPropy_Floors"},
     {"platform":"whatsapp", "label":"WhatsApp",  "url":"https://wa.me/919711533633"}
   ]'::jsonb, 'brand',
   'Social links', 'One-click links to the company''s own accounts, shown in the sidebar. Verify these before relying on them.')
ON CONFLICT (key) DO NOTHING;
