-- Two switches about the app were filed under the company's address.
--
-- `ui.inline_edit` and `ui.open_in_new_tab` sat in the `general` category, so
-- the Settings page drew them under "Your business" — below the registered
-- address, the legal name and the contact number. They are not business
-- details. They are how the CRM behaves when you click something, which is a
-- different decision made by a different person on a different day.
--
-- Their own category, so the page groups them on their own. The page titles an
-- unknown category by deriving a name from its id, so 'interface' reads as
-- "Interface" with no code change; it gets a written title in `GROUPS`
-- alongside the rest.
--
-- Nothing else moves. `business_hours` genuinely is a business detail, and the
-- address, currency, timezone and contact fields are what documents and the
-- website are stamped with.

UPDATE ipy_setting
SET category = 'interface'
WHERE key IN ('ui.inline_edit', 'ui.open_in_new_tab');
