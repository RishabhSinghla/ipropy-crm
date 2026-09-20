-- The country code to assume when a contact does not carry one.
--
-- `dialableNumber` refuses to send to a number with no country code, and that
-- refusal is right: `toE164` assumes India, and a silent Indian default sends
-- an NRI buyer's private message to a stranger, which cannot be taken back.
--
-- But on 20 September the owner met the other end of it. Most of the 22,988
-- contacts in this database were imported with a ten-digit mobile and no
-- `country_code`, so **every one of them was unreachable** — the composer
-- refused before the provider was even called.
--
-- The danger in the comment was never "a default"; it was a default **nobody
-- could see**. This is a row in the settings table with a label, so an admin
-- knows it exists, sees which country it names and can change it. Seeded to 91
-- because this business sells builder floors in Faridabad, and a contact that
-- carries its own `country_code` still wins over it.
--
-- Written with a category on purpose: `PUT /api/admin/settings` inserts a key
-- it has never seen with no category, which lands it in `general` where the
-- screen asking for it may never look. Same trap as migration 160.
INSERT INTO ipy_setting (key, value, category, label, description)
VALUES (
  'org.country_code',
  '"91"'::jsonb,
  'general',
  'Default country code',
  'Used when a contact has no country code of its own. A contact that carries one always wins.'
)
ON CONFLICT (key) DO NOTHING;
