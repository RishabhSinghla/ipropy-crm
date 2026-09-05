-- The team came off Vtiger, where this record is a Contact. "Leads & Contacts"
-- was an honest description of what the module holds — one party record for the
-- whole journey, lifecycle_stage: Lead → Prospect → Customer → Past Customer —
-- but it is not what anybody says out loud, and a two-word label with an
-- ampersand reads as two things when it is one.
--
-- The module *name* stays `leads`. It is the URL, the API path, the target of
-- every relation and the key inside every saved view, workflow condition,
-- dashboard widget and bookmark. Only the labels move.
--
-- Defensive: on a fresh database the seed already writes the new labels, so
-- these updates match nothing and no-op.

UPDATE ipy_module
SET label = 'Contacts', singular_label = 'Contact', updated_at = now()
WHERE name = 'leads';

UPDATE ipy_relation
SET label = 'Contacts'
WHERE name = 'org_leads' AND label IN ('Leads & Contacts', 'Leads & Customers');
