-- Where each rep's phone has been, and which property it was near.
--
-- The question this exists to answer is "did they get to the site". Everything
-- about the design follows from that being the question, rather than from
-- "track them".
--
-- **It is off until somebody switches it on.** `team_location.enabled` defaults
-- to false. A CRM that starts recording staff movements the moment it is
-- installed is not a thing to ship quietly.
--
-- **It expires.** Points older than the retention setting are deleted by the
-- scheduler. Location history is the most sensitive thing this database will
-- ever hold, it answers no question after a few weeks, and the cheapest way to
-- keep it safe is not to keep it.

CREATE TABLE IF NOT EXISTS ipy_device_location (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES ipy_user(id) ON DELETE CASCADE,
  device_id     UUID REFERENCES ipy_device(id) ON DELETE SET NULL,
  -- When the phone took the fix, not when the server heard about it. A handset
  -- with no signal batches up an hour of points and sends them at once, and
  -- drawing those at the moment they arrived would put a rep's whole morning on
  -- one spot.
  recorded_at   TIMESTAMPTZ NOT NULL,
  latitude      NUMERIC(10,7) NOT NULL,
  longitude     NUMERIC(10,7) NOT NULL,
  -- Metres. A fix worse than the site-match radius cannot say which building
  -- somebody is in, and the map says so rather than drawing a confident dot.
  accuracy_m    REAL,
  speed_mps     REAL,
  -- Kept because "their phone died" and "they switched it off" look identical
  -- on a map, and only one of those is worth a conversation.
  battery_pct   INT,
  source        TEXT NOT NULL DEFAULT 'android',
  /**
   * The property this point was near, worked out once when it arrives.
   *
   * Computed on the way in rather than on the way out: the map is opened far
   * more often than a point is written, and a join against every property on
   * every page load is the same answer computed a thousand times.
   */
  near_record_id UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  near_metres    REAL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every read is "this person, newest first" or "everybody, newest each".
CREATE INDEX IF NOT EXISTS idx_device_location_user
  ON ipy_device_location(user_id, recorded_at DESC);
-- The prune walks by age across everybody.
CREATE INDEX IF NOT EXISTS idx_device_location_age
  ON ipy_device_location(recorded_at);

COMMENT ON TABLE ipy_device_location IS
  'Where each rep''s phone has been. Off by default, expires on a schedule, visible only up the role hierarchy.';

INSERT INTO ipy_setting (key, value, category, label, description) VALUES
  ('team_location.enabled', 'false'::jsonb, 'team_location',
   'Record where phones are',
   'Off until you switch it on. When on, the companion app sends its position while it is within the hours below. Tell your team before you turn this on — it is their personal data and in India the DPDP Act treats it that way.'),
  ('team_location.every_minutes', '15'::jsonb, 'team_location',
   'How often to take a reading',
   'Minutes between readings. Fifteen is the fastest Android will allow a background app to wake — asking for less does not make it happen, it just makes the phone hot. Fifteen is plenty to see somebody arrive at a site.'),
  ('team_location.from_hour', '9'::jsonb, 'team_location',
   'Start recording at',
   'Hour of the day, 24-hour clock, in your own timezone. Outside these hours the app records nothing at all.'),
  ('team_location.to_hour', '20'::jsonb, 'team_location',
   'Stop recording at',
   'Hour of the day, 24-hour clock. Set both to 0 to record around the clock, though there is rarely a business reason to know where somebody sleeps.'),
  ('team_location.keep_days', '30'::jsonb, 'team_location',
   'Keep history for',
   'Days. Older points are deleted for good. Location history answers nothing after a few weeks and is the most sensitive thing this CRM holds.'),
  ('team_location.site_radius_m', '150'::jsonb, 'team_location',
   'Counts as "at the property" within',
   'Metres. A phone fix is accurate to ten or twenty metres at best, so this cannot tell one builder floor from the one next door — it tells you somebody reached the address.')
ON CONFLICT (key) DO NOTHING;
