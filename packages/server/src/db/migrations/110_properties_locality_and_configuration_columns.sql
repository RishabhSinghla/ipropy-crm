-- Bring production's ipy_e_properties back in line with what 002 declares.
--
-- 002_entities.sql has been edited many times since production first ran it,
-- and an applied migration never re-runs — so every column added to that file
-- afterwards simply never reached production's table. It is not two columns:
-- the live logs show `configuration`, `locality`, `bedrooms` and `area_unit`
-- all missing, breaking property import, buyer matching and lead scoring, and
-- killing the container outright once a later migration tried to read one.
--
-- So this reconciles the whole table rather than naming today's casualty.
-- Every statement is ADD COLUMN IF NOT EXISTS, so it is a no-op on any
-- database that ran 002 recently (local, CI, a fresh install) and a repair on
-- the one that did not. NOT NULL columns carry their default, which is what
-- lets them be added to a table that already has rows.
--
-- TWO COLUMNS ARE DELIBERATELY ABSENT: `city` and `project_name`. The owner
-- removed both on purpose — this business sells builder floors in one area —
-- and they must not be restored, indexed or otherwise depended on. That is
-- exactly what broke this migration the first time round: it ended with
-- CREATE INDEX ... (city, locality), and IF NOT EXISTS guards an index *name*,
-- never a missing column, so Postgres raised 42703, migrate.js threw, and
-- docker-entrypoint.sh under `set -e` meant the server never started at all.

-- identity and classification
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS property_code       TEXT;
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS property_type       TEXT;
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS configuration       TEXT;

-- physical position
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS tower               TEXT;
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS wing                TEXT;
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS floor               INT;
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS unit_number         TEXT;
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS facing              TEXT;
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS view_description    TEXT;
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS corner_unit         BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS vastu_compliant     BOOLEAN;

-- areas
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS carpet_area         NUMERIC(12,2);
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS built_up_area       NUMERIC(12,2);
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS super_built_up_area NUMERIC(12,2);
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS plot_area           NUMERIC(12,2);
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS balcony_area        NUMERIC(12,2);
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS terrace_area        NUMERIC(12,2);
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS area_unit           TEXT NOT NULL DEFAULT 'sqft';

-- rooms
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS bedrooms            INT;
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS bathrooms           INT;
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS balconies           INT;
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS parking_slots       INT;
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS furnishing          TEXT;

-- pricing
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS base_price          NUMERIC(18,2);
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS rate_per_sqft       NUMERIC(12,2);
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS floor_rise_charge   NUMERIC(18,2);
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS plc_charge          NUMERIC(18,2);
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS parking_charge      NUMERIC(18,2);
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS club_membership     NUMERIC(18,2);
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS maintenance_deposit NUMERIC(18,2);
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS other_charges       NUMERIC(18,2);
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS gst_percent         NUMERIC(5,2);
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS stamp_duty_percent  NUMERIC(5,2);
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS registration_charge NUMERIC(18,2);
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS total_price         NUMERIC(18,2);

-- rental
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS monthly_rent        NUMERIC(18,2);
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS security_deposit    NUMERIC(18,2);
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS maintenance_monthly NUMERIC(18,2);

-- availability
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS possession_status   TEXT;
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS possession_date     DATE;
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS blocked_until       TIMESTAMPTZ;
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS blocked_by          UUID REFERENCES ipy_user(id)   ON DELETE SET NULL;
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS blocked_for_lead_id UUID REFERENCES ipy_record(id) ON DELETE SET NULL;

-- resale / owner
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS owner_contact_id    UUID REFERENCES ipy_record(id) ON DELETE SET NULL;
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS is_resale           BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS age_of_property     INT;

-- media
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS gallery             JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS floor_plan_url      TEXT;
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS video_url           TEXT;
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS virtual_tour_url    TEXT;
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS amenities           JSONB NOT NULL DEFAULT '[]'::jsonb;

-- location (city is deliberately NOT here — see the header)
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS locality            TEXT;
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS latitude            NUMERIC(10,7);
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS longitude           NUMERIC(10,7);
ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS description         TEXT;

CREATE INDEX IF NOT EXISTS idx_prop_config   ON ipy_e_properties(configuration);
CREATE INDEX IF NOT EXISTS idx_prop_locality ON ipy_e_properties(locality);
