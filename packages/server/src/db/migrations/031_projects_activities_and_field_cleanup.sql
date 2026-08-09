-- ===========================================================================
-- iPropy CRM — 031: Projects and Activities removed; lead fields simplified
--
-- 030 left four modules standing and kept Projects and Activities alive but off
-- the menu. Both are now gone for good, leaving three:
--
--   Leads & Contacts   — the person, with their calls, notes and timeline
--   Properties         — units, each carrying its development's name itself
--   Campaigns          — marketing
--
-- Alongside that, three field changes on Leads:
--
--   * Carpet Area (Min) + (Max)  →  one Area, with its unit beside it
--   * Country                    →  folded into the Mobile control
--   * follow-up / contacted / scored / converted  →  dates, not date-times
--
-- **Records are deleted here.** Unlike 030 the payload rows are copied to
-- `*_archive` tables first, because 207 activities and 6 projects is a small
-- enough amount of data that keeping it costs nothing and a wrong call costs a
-- restore. Nothing in the application reads those tables — drop them by hand
-- once you are sure.
--
-- Order matters, as in 030: cross-module references first, then records through
-- `ipy_record` so payload rows cascade, then metadata, then tables.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Layouts an administrator has edited must survive re-seeding
--
-- Sections, header fields and the default tab are admin controls now. The seed
-- rewrites the default layout of every module on each run, which would undo all
-- three; it now skips any layout flagged here, and the admin API sets the flag
-- on save.
-- ---------------------------------------------------------------------------

ALTER TABLE ipy_layout ADD COLUMN IF NOT EXISTS is_customised BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 2. Leads: one Area instead of a carpet-area range
--
-- A buyer states one requirement — "around 1200 sq.ft" — so two fields were
-- collecting one answer, and neither carried the unit that makes the number
-- mean anything. The existing range collapses to its midpoint (or whichever end
-- was filled), which is the closest single value to what was meant.
-- ---------------------------------------------------------------------------

ALTER TABLE ipy_e_leads
  ADD COLUMN IF NOT EXISTS area      NUMERIC,
  ADD COLUMN IF NOT EXISTS area_unit TEXT NOT NULL DEFAULT 'sqft';

UPDATE ipy_e_leads
SET area = CASE
             WHEN carpet_area_min IS NOT NULL AND carpet_area_max IS NOT NULL
               THEN round((carpet_area_min + carpet_area_max) / 2)
             ELSE COALESCE(carpet_area_min, carpet_area_max)
           END
WHERE area IS NULL
  AND (carpet_area_min IS NOT NULL OR carpet_area_max IS NOT NULL);

DELETE FROM ipy_field
WHERE name IN ('carpet_area_min', 'carpet_area_max')
  AND module_id = (SELECT id FROM ipy_module WHERE name = 'leads');

ALTER TABLE ipy_e_leads
  DROP COLUMN IF EXISTS carpet_area_min,
  DROP COLUMN IF EXISTS carpet_area_max;

-- ---------------------------------------------------------------------------
-- 3. Leads: dates without a time
--
-- Nobody schedules a follow-up for 5:48pm — that value came from `now()` and
-- read as a commitment. The columns become DATE so the stored value matches
-- what the form asks for; every writer either passes `now()` or an ISO string,
-- both of which cast on assignment.
-- ---------------------------------------------------------------------------

ALTER TABLE ipy_e_leads
  ALTER COLUMN next_followup_at  TYPE DATE USING next_followup_at::date,
  ALTER COLUMN last_contacted_at TYPE DATE USING last_contacted_at::date,
  ALTER COLUMN ai_scored_at      TYPE DATE USING ai_scored_at::date,
  ALTER COLUMN converted_at      TYPE DATE USING converted_at::date;

ALTER TABLE ipy_e_properties
  ALTER COLUMN blocked_until TYPE DATE USING blocked_until::date;

UPDATE ipy_field SET uitype = 'date'
WHERE uitype = 'datetime'
  AND ((name IN ('next_followup_at', 'last_contacted_at', 'ai_scored_at', 'converted_at')
        AND module_id = (SELECT id FROM ipy_module WHERE name = 'leads'))
    OR (name = 'blocked_until'
        AND module_id = (SELECT id FROM ipy_module WHERE name = 'properties')));

-- ---------------------------------------------------------------------------
-- 4. Leads: the country code moves inside the Mobile control
--
-- It stays a stored field — a silent +91 sends an NRI buyer's WhatsApp to a
-- stranger in India — but stops being a form row of its own. Hiding it is what
-- takes it out of layouts; the codes list is what the Mobile field's dropdown
-- renders, since that control only ever sees its own metadata.
-- ---------------------------------------------------------------------------

UPDATE ipy_field
SET display_type = 'hidden', quick_create = false, label = 'Country Code'
WHERE name = 'country_code'
  AND module_id = (SELECT id FROM ipy_module WHERE name = 'leads');

UPDATE ipy_field
SET config = config || jsonb_build_object('countryCodes', jsonb_build_array(
      jsonb_build_object('value', '+91',  'label', 'India +91'),
      jsonb_build_object('value', '+971', 'label', 'UAE +971'),
      jsonb_build_object('value', '+966', 'label', 'Saudi Arabia +966'),
      jsonb_build_object('value', '+974', 'label', 'Qatar +974'),
      jsonb_build_object('value', '+968', 'label', 'Oman +968'),
      jsonb_build_object('value', '+965', 'label', 'Kuwait +965'),
      jsonb_build_object('value', '+973', 'label', 'Bahrain +973'),
      jsonb_build_object('value', '+65',  'label', 'Singapore +65'),
      jsonb_build_object('value', '+61',  'label', 'Australia +61'),
      jsonb_build_object('value', '+44',  'label', 'United Kingdom +44'),
      jsonb_build_object('value', '+1',   'label', 'USA / Canada +1')
    )),
    help_text = 'Pick the country code, then the number without it'
WHERE name = 'mobile'
  AND module_id = (SELECT id FROM ipy_module WHERE name = 'leads');

-- ---------------------------------------------------------------------------
-- 5. Properties keep their development, as their own text
--
-- The reference is what disappears, not the information: each unit's project
-- name is copied onto the unit before the link is broken.
-- ---------------------------------------------------------------------------

ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS project_name TEXT;

UPDATE ipy_e_properties p
SET project_name = r.label
FROM ipy_record r
WHERE r.id = p.project_id AND p.project_name IS NULL;

ALTER TABLE ipy_e_leads ADD COLUMN IF NOT EXISTS interested_project TEXT;

UPDATE ipy_e_leads l
SET interested_project = r.label
FROM ipy_record r
WHERE r.id = l.interested_project_id AND l.interested_project IS NULL;

-- ---------------------------------------------------------------------------
-- 6. Cross-module references, before their target disappears
-- ---------------------------------------------------------------------------

DELETE FROM ipy_field
WHERE (name = 'interested_project_id' AND module_id = (SELECT id FROM ipy_module WHERE name = 'leads'))
   OR (name = 'project_id'            AND module_id = (SELECT id FROM ipy_module WHERE name = 'properties'))
   OR (name = 'project_id'            AND module_id = (SELECT id FROM ipy_module WHERE name = 'campaigns'));

ALTER TABLE ipy_e_leads      DROP COLUMN IF EXISTS interested_project_id;
ALTER TABLE ipy_e_properties DROP COLUMN IF EXISTS project_id;
ALTER TABLE ipy_e_campaigns  DROP COLUMN IF EXISTS project_id;

-- A tracking number could route by project. Nothing to route to now; the
-- campaign and lead-source attributions on the same row are unaffected.
ALTER TABLE ipy_virtual_number DROP COLUMN IF EXISTS project_id;

-- ---------------------------------------------------------------------------
-- 7. Archive, then delete
--
-- Through `ipy_record` so attachments, comments, audit rows and timeline
-- entries cascade rather than being orphaned by a bare DROP TABLE.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ipy_e_activities_archive AS TABLE ipy_e_activities;
CREATE TABLE IF NOT EXISTS ipy_e_projects_archive   AS TABLE ipy_e_projects;

DELETE FROM ipy_record WHERE module_name IN ('activities', 'projects');

DELETE FROM ipy_relation
WHERE source_module_id IN (SELECT id FROM ipy_module WHERE name IN ('activities', 'projects'))
   OR target_module_id IN (SELECT id FROM ipy_module WHERE name IN ('activities', 'projects'));

DELETE FROM ipy_module WHERE name IN ('activities', 'projects');

DROP TABLE IF EXISTS ipy_e_activities;
DROP TABLE IF EXISTS ipy_e_projects;

-- ---------------------------------------------------------------------------
-- 8. Anything still pointing at them
-- ---------------------------------------------------------------------------

DELETE FROM ipy_dashboard_widget
WHERE config->>'module' IN ('activities', 'projects');

DELETE FROM ipy_dashboard d
WHERE NOT EXISTS (SELECT 1 FROM ipy_dashboard_widget w WHERE w.dashboard_id = d.id)
  AND d.is_system = true;

DELETE FROM ipy_workflow w
WHERE NOT EXISTS (SELECT 1 FROM ipy_module m WHERE m.id = w.module_id);

-- Saved views and layouts naming a column that no longer exists would render a
-- blank cell or an empty section, so strip the names out rather than leaving
-- them to fail quietly.
UPDATE ipy_view
SET columns = COALESCE((
      SELECT jsonb_agg(c) FROM jsonb_array_elements_text(columns) AS c
      WHERE c NOT IN ('project_id', 'interested_project_id', 'carpet_area_min', 'carpet_area_max', 'country_code')
    ), '[]'::jsonb)
WHERE columns ?| array['project_id', 'interested_project_id', 'carpet_area_min', 'carpet_area_max', 'country_code'];

UPDATE ipy_layout
SET config = jsonb_set(
      config,
      '{blocks}',
      COALESCE((
        SELECT jsonb_agg(
                 b || jsonb_build_object('fields', COALESCE((
                   SELECT jsonb_agg(f) FROM jsonb_array_elements_text(b->'fields') AS f
                   WHERE f NOT IN ('project_id', 'interested_project_id', 'carpet_area_min',
                                   'carpet_area_max', 'country_code')
                 ), '[]'::jsonb))
               )
        FROM jsonb_array_elements(config->'blocks') AS b
      ), '[]'::jsonb)
    )
WHERE config ? 'blocks';

-- Header chips and the default tab, for layouts seeded before either existed.
UPDATE ipy_layout
SET config = config
      || jsonb_build_object('defaultTab', COALESCE(config->>'defaultTab', 'overview'))
      || jsonb_build_object('headerFields', COALESCE((
           SELECT jsonb_agg(h) FROM jsonb_array_elements_text(COALESCE(config->'headerFields', '[]'::jsonb)) AS h
           WHERE h NOT IN ('country_code', 'interested_project_id', 'project_id')
         ), '[]'::jsonb))
      - 'tabs'
WHERE type = 'detail';

-- The inventory board is gone; the kanban view that shared its name is not.
UPDATE ipy_view SET name = 'By Status'
WHERE name = 'Inventory Board'
  AND module_id = (SELECT id FROM ipy_module WHERE name = 'properties');
