-- Associates are dealers and builders — companies — so their icon is a
-- building, not the two-people icon they were cloned from Leads with
-- (the owner, 2 October 2026: "change associate icon … into
-- company/organization type icon").
--
-- Only while it still carries the icon migration 175 gave it: an icon an admin
-- has since chosen is a decision, and this does not overwrite it. A database
-- with no Associates module changes nothing.
UPDATE ipy_module
   SET icon = 'building-2'
 WHERE name = 'associates'
   AND icon = 'users';
