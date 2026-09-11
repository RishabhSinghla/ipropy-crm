-- Rename the two core modules everywhere a person sees their names, while
-- keeping the permanent machine keys (`leads`, `properties`) untouched. Those
-- keys are referenced by URLs, imports, automations, permissions and APIs.
UPDATE ipy_module
SET label = 'Leads', singular_label = 'Lead', updated_at = now()
WHERE name = 'leads';

UPDATE ipy_module
SET label = 'Inventories', singular_label = 'Inventory', updated_at = now()
WHERE name = 'properties';

UPDATE ipy_relation
SET label = 'Leads'
WHERE label IN ('Contacts', 'Leads & Contacts', 'Leads & Customers')
  AND (
    name = 'org_leads'
    OR target_module_id = (SELECT id FROM ipy_module WHERE name = 'leads')
  );

UPDATE ipy_relation
SET label = 'Inventories'
WHERE label IN ('Properties', 'Property')
  AND target_module_id = (SELECT id FROM ipy_module WHERE name = 'properties');

-- Default list tabs should read naturally under the new module headings.
UPDATE ipy_view v
SET name = 'All Leads', seed_key = 'All Leads'
FROM ipy_module m
WHERE v.module_id = m.id AND m.name = 'leads'
  AND v.seed_key = 'All Records';

UPDATE ipy_view v
SET name = 'All Inventories', seed_key = 'All Inventories'
FROM ipy_module m
WHERE v.module_id = m.id AND m.name = 'properties'
  AND v.seed_key = 'All Inventory';

-- Preserve the admin's custom tab ordering; only replace old display words.
UPDATE ipy_setting
SET value = replace(
              replace(
                replace(
                  replace(value::text, '"Contacts"', '"Leads"'),
                  '"Properties"', '"Inventories"'
                ),
                '"Contact"', '"Lead"'
              ),
              '"Property"', '"Inventory"'
            )::jsonb,
    updated_at = now()
WHERE key = 'ui.header_tabs';

-- Detail-layout tab captions are stored snapshots, so migrate those too.
UPDATE ipy_layout
SET config = replace(
               replace(config::text, '"Matching contacts"', '"Matching leads"'),
               '"Matching property"', '"Matching inventory"'
             )::jsonb,
    updated_at = now()
WHERE module_id IN (SELECT id FROM ipy_module WHERE name IN ('leads', 'properties'));
