-- ===========================================================================
-- iPropy CRM — 030: eight modules removed for good
--
-- 025 deactivated these behind a flag, which was the cautious first step.
-- Confirmed since: remove them properly. Tables dropped, records deleted,
-- metadata gone.
--
-- **This is not reversible.** A restore from backup is the only way back, which
-- is why the data was checked before writing this: everything here was demo
-- seed data apart from one blog post and one test deal named "qewrytuyui".
--
-- What is left afterwards is four things:
--
--   Leads & Contacts   — the person, with their activities, calls and timeline
--   Properties         — units, with their project on the same form
--   Campaigns          — marketing
--   Admin              — everything configurable
--
-- Order matters. `ipy_record` is the shared id space and every entity table
-- cascades from it, so deleting the records empties the payload tables first;
-- dropping the module rows then cascades through fields, blocks, relations and
-- views. Dropping tables before either would leave orphaned metadata behind.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Cross-module references, before their targets disappear
--
-- A reference field pointing at a module that no longer exists renders a
-- permanently broken lookup, and `channel_partner_id` holds 13 ids that are
-- about to point at nothing.
-- ---------------------------------------------------------------------------

DELETE FROM ipy_field
WHERE name IN ('organization_id', 'converted_org_id', 'converted_deal_id', 'channel_partner_id')
  AND module_id = (SELECT id FROM ipy_module WHERE name = 'leads');

DELETE FROM ipy_field
WHERE name = 'developer_id'
  AND module_id = (SELECT id FROM ipy_module WHERE name = 'projects');

ALTER TABLE ipy_e_leads
  DROP COLUMN IF EXISTS organization_id,
  DROP COLUMN IF EXISTS converted_org_id,
  DROP COLUMN IF EXISTS converted_deal_id,
  DROP COLUMN IF EXISTS channel_partner_id;

ALTER TABLE ipy_e_projects DROP COLUMN IF EXISTS developer_id;

-- Activities can be "related to" several modules; narrow the list to the two
-- that survive, or the picker offers targets that cannot be resolved.
UPDATE ipy_field
SET config = jsonb_set(config, '{referenceModules}', '["leads","properties","projects"]'::jsonb)
WHERE name = 'related_to'
  AND module_id = (SELECT id FROM ipy_module WHERE name = 'activities');

-- Conversion turned a lead into an Organisation plus a Deal. With both gone
-- there is nothing to convert *to*, so the capability goes with them.
UPDATE ipy_module SET supports_conversion = false WHERE name = 'leads';

-- ---------------------------------------------------------------------------
-- 2. Records
--
-- Deleted through `ipy_record` so every payload row, attachment, comment,
-- timeline entry and audit row cascades away with it rather than being
-- orphaned by a bare DROP TABLE.
-- ---------------------------------------------------------------------------

DELETE FROM ipy_record
WHERE module_name IN (
  'blog_posts', 'documents', 'payments', 'bookings',
  'channel_partners', 'deals', 'site_visits', 'organizations'
);

-- ---------------------------------------------------------------------------
-- 3. Metadata
--
-- Fields, blocks, relations, views and sharing rules are all FK'd to the module
-- with ON DELETE CASCADE, so this one statement takes the lot.
-- ---------------------------------------------------------------------------

-- Relations in either direction, including any pointing *at* a doomed module
-- from one that survives.
DELETE FROM ipy_relation
WHERE source_module_id IN (SELECT id FROM ipy_module WHERE name IN (
        'blog_posts','documents','payments','bookings','channel_partners','deals','site_visits','organizations'))
   OR target_module_id IN (SELECT id FROM ipy_module WHERE name IN (
        'blog_posts','documents','payments','bookings','channel_partners','deals','site_visits','organizations'));

DELETE FROM ipy_module
WHERE name IN (
  'blog_posts', 'documents', 'payments', 'bookings',
  'channel_partners', 'deals', 'site_visits', 'organizations'
);

-- ---------------------------------------------------------------------------
-- 4. Tables
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS ipy_e_blog_posts;
DROP TABLE IF EXISTS ipy_e_documents;
DROP TABLE IF EXISTS ipy_e_payments;
DROP TABLE IF EXISTS ipy_e_bookings;
DROP TABLE IF EXISTS ipy_e_channel_partners;
DROP TABLE IF EXISTS ipy_e_deals;
DROP TABLE IF EXISTS ipy_e_site_visits;
DROP TABLE IF EXISTS ipy_e_organizations;

-- The channel-partner portal is gone with its module; the column linking a
-- user to a partner record has nothing left to point at.
ALTER TABLE ipy_user DROP COLUMN IF EXISTS channel_partner_id;

-- ---------------------------------------------------------------------------
-- 5. Anything still referring to them
-- ---------------------------------------------------------------------------

-- Widgets and dashboards left empty (029 did this for the first five modules;
-- Deals, Site Visits and Organisations join them now).
DELETE FROM ipy_dashboard_widget
WHERE config->>'module' IN ('deals', 'site_visits', 'organizations', 'payments', 'bookings',
                            'channel_partners', 'documents', 'blog_posts');

DELETE FROM ipy_dashboard d
WHERE NOT EXISTS (SELECT 1 FROM ipy_dashboard_widget w WHERE w.dashboard_id = d.id)
  AND d.is_system = true;

-- Workflows that acted on a module that no longer exists. `ipy_workflow` keys
-- on `module_id`, and the module rows are already gone by this point, so this
-- has to catch the orphans rather than match on a name.
DELETE FROM ipy_workflow w
WHERE NOT EXISTS (SELECT 1 FROM ipy_module m WHERE m.id = w.module_id);

-- ---------------------------------------------------------------------------
-- 6. The four that remain
--
-- Activities keeps its data and stays off the menu — it is the "Activities" tab
-- inside a lead. Projects likewise, reached through the property form rather
-- than a tab of its own.
-- ---------------------------------------------------------------------------

UPDATE ipy_module SET show_in_menu = true,  menu_group = 'CRM', sequence = 10 WHERE name = 'leads';
UPDATE ipy_module SET show_in_menu = true,  menu_group = 'CRM', sequence = 20 WHERE name = 'properties';
UPDATE ipy_module SET show_in_menu = true,  menu_group = 'CRM', sequence = 30 WHERE name = 'campaigns';
UPDATE ipy_module SET show_in_menu = false, sequence = 40 WHERE name IN ('activities', 'projects');

-- The tab strip added in 028 is not wanted: a project belongs on the property
-- form, not behind a second tab.
UPDATE ipy_module SET settings = settings - 'tabGroup' - 'tabOrder'
WHERE name IN ('properties', 'projects');

UPDATE ipy_module SET label = 'Properties', singular_label = 'Property' WHERE name = 'properties';
