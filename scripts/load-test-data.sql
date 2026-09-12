-- ===========================================================================
-- A year of iPropy, for finding what falls over.
--
-- Query plans that are instant against ninety-nine rows are a different shape
-- against a hundred thousand: a sequential scan nobody notices becomes the
-- whole response time, and an index that was never needed becomes the
-- difference between a list that opens and one that times out. None of that
-- shows up in development, and all of it shows up on the first busy morning.
--
-- Sized to a real year at this desk rather than to a round number: five to ten
-- properties photographed a day, a few hundred enquiries a month across the
-- website, the portals and walk-ins, and a timeline entry for everything
-- anybody ever did to either.
--
-- **Never point this at a database you care about.** It is written for a
-- throwaway `ipropy_scale`, and it inserts directly rather than through
-- recordService, so none of the usual validation or workflows run — that is
-- the point (it is loading a year in a minute), and it is also why the data is
-- shaped by hand to stay realistic.
-- ===========================================================================

\set ON_ERROR_STOP on

-- --- leads -----------------------------------------------------------------
INSERT INTO ipy_record (id, module_id, module_name, record_number, label, owner_id, owner_type, created_by, created_at, updated_at, search_text)
SELECT
  gen_random_uuid(),
  m.id, 'leads',
  'LD-' || lpad((100000 + g)::text, 6, '0'),
  (ARRAY['Aarav','Vivaan','Aditya','Diya','Riya','Ananya','Kabir','Ishaan','Meera','Rohan','Priya','Sanya','Arjun','Neha','Karan'])[1 + (g % 15)]
    || ' ' || (ARRAY['Sharma','Verma','Iyer','Nair','Bose','Kulkarni','Reddy','Gupta','Singh','Mehta'])[1 + (g % 10)],
  u.id, 'user', u.id,
  now() - (random() * 365 || ' days')::interval,
  now() - (random() * 30 || ' days')::interval,
  'lead ' || g
FROM generate_series(1, 60000) g
CROSS JOIN LATERAL (SELECT id FROM ipy_module WHERE name = 'leads') m
CROSS JOIN LATERAL (SELECT id FROM ipy_user ORDER BY md5(g::text || id::text) LIMIT 1) u;

-- `country_code`, `lifecycle_stage`, `budget_min`, `budget_max` and `ai_score`
-- were all named here and none of them is on the model any more, so this
-- script had stopped loading anything at all — it errored after inserting
-- 60,000 `ipy_record` rows and left the database half built. Which means the
-- performance figures in CLAUDE.md could not be reproduced by anybody who
-- tried. One budget field now, as the model has.
INSERT INTO ipy_e_leads (record_id, full_name, mobile, email, status,
                         budget, budget_unit, configuration, preferred_locations,
                         next_followup_at, is_converted, lost_reason, custom_fields)
SELECT
  r.id,
  r.label,
  '9' || lpad(((row_number() OVER ()) % 900000000)::text, 9, '0'),
  lower(replace(r.label, ' ', '.')) || (row_number() OVER ()) || '@example.com',
  (ARRAY['New','Attempted Contact','Contacted','Qualified','Site Visit Scheduled','Site Visit Done','Negotiation','Converted','Junk','Lost'])[1 + (abs(hashtext(r.id::text)) % 10)],
  (15 + (abs(hashtext(r.id::text)) % 40)) * 1000000,
  'total',
  to_jsonb(ARRAY[(ARRAY['1 BHK','2 BHK','3 BHK','4 BHK'])[1 + (abs(hashtext(r.id::text)) % 4)]]),
  to_jsonb(ARRAY[(ARRAY['Powai','Kharadi','Sarjapur Road','Andheri West','Baner'])[1 + (abs(hashtext(r.id::text)) % 5)]]),
  CURRENT_DATE + ((abs(hashtext(r.id::text)) % 60) - 30),
  false,
  CASE WHEN (abs(hashtext(r.id::text)) % 10) = 9
       THEN (ARRAY['Price Too High','Budget Mismatch','Bought Elsewhere','Loan Rejected','No Response'])[1 + (abs(hashtext(r.id::text)) % 5)]
       END,
  '{}'::jsonb
FROM ipy_record r
WHERE r.module_name = 'leads' AND r.record_number LIKE 'LD-1%';

-- --- properties ------------------------------------------------------------
INSERT INTO ipy_record (id, module_id, module_name, record_number, label, owner_id, owner_type, created_by, created_at, updated_at, search_text)
SELECT
  gen_random_uuid(), m.id, 'properties',
  'UNIT-' || lpad((100000 + g)::text, 6, '0'),
  (ARRAY['Skyline Aurum','Meridian Crest','Verdant Greens','Greenfield Heights','Palm Enclave'])[1 + (g % 5)]
    || ' — ' || chr(65 + (g % 6)) || '-' || (100 + (g % 900)),
  u.id, 'user', u.id,
  now() - (random() * 365 || ' days')::interval,
  now() - (random() * 30 || ' days')::interval,
  'unit ' || g
FROM generate_series(1, 8000) g
CROSS JOIN LATERAL (SELECT id FROM ipy_module WHERE name = 'properties') m
CROSS JOIN LATERAL (SELECT id FROM ipy_user ORDER BY md5(g::text || id::text) LIMIT 1) u;

-- `name`, `configuration` and `carpet_area` have gone the same way: the unit's
-- name is `full_name`, its BHK is `bedrooms`, and its size is `area` with an
-- `area_unit` beside it.
INSERT INTO ipy_e_properties (record_id, full_name, status, bedrooms, base_price, total_price,
                              area, area_unit, city, locality, possession_status, floor, facing,
                              vastu_compliant, corner_unit, custom_fields)
SELECT
  r.id, r.label,
  (ARRAY['Available','Available','Available','Held','Booked','Sold'])[1 + (abs(hashtext(r.id::text)) % 6)],
  -- A number here, not '3 BHK': on a seeded database `bedrooms` is an integer
  -- column, while production's `bedrooms` is a picklist of labels backed by
  -- `configuration`. The matcher reads both; this file has to match whichever
  -- database it is pointed at, and it is only ever pointed at a fresh one.
  1 + (abs(hashtext(r.id::text)) % 4),
  (40 + (abs(hashtext(r.id::text)) % 300)) * 100000,
  (42 + (abs(hashtext(r.id::text)) % 300)) * 100000,
  400 + (abs(hashtext(r.id::text)) % 1600),
  'sqft',
  (ARRAY['Mumbai','Pune','Bengaluru'])[1 + (abs(hashtext(r.id::text)) % 3)],
  (ARRAY['Powai','Kharadi','Sarjapur Road','Andheri West','Baner'])[1 + (abs(hashtext(r.id::text)) % 5)],
  (ARRAY['Ready To Move','Under Construction','New Launch'])[1 + (abs(hashtext(r.id::text)) % 3)],
  1 + (abs(hashtext(r.id::text)) % 30),
  (ARRAY['North','South','East','West','North-East'])[1 + (abs(hashtext(r.id::text)) % 5)],
  (abs(hashtext(r.id::text)) % 2) = 0,
  (abs(hashtext(r.id::text)) % 5) = 0,
  '{}'::jsonb
FROM ipy_record r
WHERE r.module_name = 'properties' AND r.record_number LIKE 'UNIT-1%';

-- --- the audit trail, which grows fastest of all ---------------------------
INSERT INTO ipy_audit (record_id, module_name, user_id, action, changes, source, created_at)
SELECT r.id, r.module_name, r.created_by,
       (ARRAY['create','update','update','update','view'])[1 + (g % 5)],
       '[]'::jsonb, 'app',
       r.created_at + (g || ' hours')::interval
FROM ipy_record r
CROSS JOIN generate_series(1, 4) g
WHERE r.record_number LIKE 'LD-1%' OR r.record_number LIKE 'UNIT-1%';

ANALYZE;

SELECT 'leads' AS what, count(*) FROM ipy_e_leads
UNION ALL SELECT 'properties', count(*) FROM ipy_e_properties
UNION ALL SELECT 'records', count(*) FROM ipy_record
UNION ALL SELECT 'audit rows', count(*) FROM ipy_audit;
