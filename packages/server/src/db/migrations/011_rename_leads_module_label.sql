-- The module was labelled "Leads & Customers" because one record carries the
-- whole journey (lifecycle_stage: Lead → Prospect → Customer → Past Customer).
-- "Contacts" is the term the business actually uses for that record, so the
-- label follows the business. The module *name* stays `leads` — it is the URL,
-- the API path and the target of every relation, and renaming it would break
-- saved views, workflows and bookmarks for no gain.
--
-- Defensive: on a fresh database the seed already writes the new label, so
-- these updates match nothing and no-op.

UPDATE ipy_module
SET label = 'Leads & Contacts', updated_at = now()
WHERE name = 'leads' AND label = 'Leads & Customers';

UPDATE ipy_relation
SET label = 'Leads & Contacts'
WHERE name = 'org_leads' AND label = 'Leads & Customers';
