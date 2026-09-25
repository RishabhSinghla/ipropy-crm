-- A two- or three-letter tag for each module, shown on every WhatsApp chat so a
-- rep can tell at a glance whether the person is a lead or an inventory owner.
--
-- 25 September 2026, the owner: *"denoting LD (meaning lead) and INV (meaning
-- Inventories)"*. Stored on the module rather than written into the screen, so
-- the product stays metadata-driven: a module an admin adds later gets a tag
-- from its own label, and an admin can change these two without a deploy.
--
-- `||` with the existing value on the right, so a label somebody has already
-- set wins — the same rule the seed uses when it merges module settings.
UPDATE ipy_module SET settings = '{"shortLabel": "LD"}'::jsonb  || settings WHERE name = 'leads';
UPDATE ipy_module SET settings = '{"shortLabel": "INV"}'::jsonb || settings WHERE name = 'properties';
