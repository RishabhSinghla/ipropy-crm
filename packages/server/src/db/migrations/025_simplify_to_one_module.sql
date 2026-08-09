-- ===========================================================================
-- iPropy CRM — 025: collapse thirteen modules into two places to look
--
-- The CRM grew a module per noun, which is correct as a data model and wrong
-- as a product for a small sales desk. A salesperson does not think "I will now
-- open the Site Visits module" — they open a person and see everything about
-- them. So: one place for people (Leads & Contacts), one for stock
-- (Properties), and nothing else in the menu.
--
-- **Nothing is dropped.** Every table, row and foreign key stays exactly where
-- it is. This migration only changes two booleans per module:
--
--   * `is_active = false`  — retired. Gone from the menu, the API and search.
--     Reversible by flipping it back; the data is untouched underneath.
--   * `show_in_menu = false` — still fully live, still readable and writable,
--     just reached through the lead or property it belongs to instead of a
--     nav item of its own.
--
-- That distinction is the whole design. Deals and Site Visits are not being
-- deleted — a deal is still a deal — they simply stop being a destination.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Retired outright
--
-- Five modules the business does not use. Blog was built for the website and is
-- managed there; Documents duplicates the attachments every record already has;
-- Payments, Bookings and Channel Partners describe a process this desk does not
-- run in the CRM.
-- ---------------------------------------------------------------------------

UPDATE ipy_module
SET is_active = false, show_in_menu = false
WHERE name IN ('blog_posts', 'documents', 'payments', 'bookings', 'channel_partners');

-- A related list pointing at a retired module would render a tab that 404s, so
-- the relationships go with them — in both directions, since a retired module
-- can be either end.
UPDATE ipy_relation
SET is_active = false
WHERE source_module_id IN (SELECT id FROM ipy_module WHERE is_active = false)
   OR target_module_id IN (SELECT id FROM ipy_module WHERE is_active = false);

-- Views gain an on/off switch.
--
-- Needed here so a retired module's views stop being offered, and needed
-- generally so the views admin can hide a tab without destroying its filter —
-- deleting a view someone spent time building, because they wanted it off the
-- strip for a month, is the kind of thing that stops people customising at all.
ALTER TABLE ipy_view ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

UPDATE ipy_view
SET is_active = false
WHERE module_id IN (SELECT id FROM ipy_module WHERE is_active = false);

-- ---------------------------------------------------------------------------
-- Folded into Leads & Contacts
--
-- These stay completely functional. A deal is still created, still reported on,
-- still drives the pipeline — it is just reached by opening the person it
-- belongs to, which is how anyone actually looks for it.
-- ---------------------------------------------------------------------------

UPDATE ipy_module
SET show_in_menu = false
WHERE name IN ('organizations', 'site_visits', 'deals', 'activities');

-- ---------------------------------------------------------------------------
-- Folded into Properties
--
-- A project is a container for units. Keeping it as its own menu entry meant
-- two clicks and a mental model before anyone could reach a flat.
-- ---------------------------------------------------------------------------

UPDATE ipy_module
SET show_in_menu = false
WHERE name = 'projects';

UPDATE ipy_module
SET label = 'Properties', singular_label = 'Property', menu_group = 'Inventory', sequence = 20
WHERE name = 'properties';

UPDATE ipy_module
SET label = 'Leads & Contacts', singular_label = 'Lead', menu_group = 'Sales', sequence = 10
WHERE name = 'leads';

-- ---------------------------------------------------------------------------
-- Tab ordering on the lead
--
-- The record page renders related lists in `sequence` order, and the order is
-- the whole point of a small tab strip: the two people look at every day come
-- first, the rest follow.
-- ---------------------------------------------------------------------------

UPDATE ipy_relation SET sequence = 10 WHERE name = 'lead_activities';
UPDATE ipy_relation SET sequence = 20 WHERE name = 'lead_site_visits';
UPDATE ipy_relation SET sequence = 30 WHERE name = 'lead_deals';
