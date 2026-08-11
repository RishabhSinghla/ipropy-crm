-- Stop the seed from undoing an administrator's work.
--
-- docker-entrypoint.sh runs db:seed on every deploy *and* every cold start, and
-- on Render's free plan a cold start happens whenever the instance has been
-- idle for fifteen minutes. Anything the seed overwrote was therefore being
-- reset several times a day, not just on deploy.
--
-- The companion change makes the seed create-only for content an admin owns
-- (dashboards, workflows, templates, picklist values, profiles, …). Fields are
-- the one exception: the code depends on their structure existing, so they must
-- keep upserting. This flag is what lets that upsert preserve the presentation
-- columns the field editor writes while still fixing up storage/column_name.
--
-- Mirrors ipy_layout.is_customised, which already solved exactly this for
-- layouts (see seed/helpers.ts seedDefaultLayouts).

ALTER TABLE ipy_field ADD COLUMN IF NOT EXISTS is_customised BOOLEAN NOT NULL DEFAULT false;

-- Fields carrying admin-authored config (validation rules, conditional
-- visibility, format presets) are edited fields by definition — the seed's own
-- definitions never set those keys. Backfilling them means work already done in
-- the field editor survives this deploy, rather than being preserved only from
-- the next edit onwards.
UPDATE ipy_field
   SET is_customised = true
 WHERE is_customised = false
   AND (config ? 'visibleWhen' OR config ? 'validation' OR config ? 'format' OR config ? 'compare');
