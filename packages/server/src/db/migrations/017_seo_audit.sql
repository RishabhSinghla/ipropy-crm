-- ===========================================================================
-- iPropy CRM — 017: daily SEO / AEO / GEO audit results
--
-- One row per run, keeping the findings as JSONB rather than a normalised
-- table: nothing queries an individual finding, the whole report is read at
-- once, and the check list changes as search does — which would otherwise mean
-- a migration every time a new check is added.
--
-- Rows are pruned to 90 days by the job itself: long enough to see whether the
-- score is trending the right way, short enough that this never becomes a
-- table anyone has to think about.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS ipy_seo_audit (
  id            BIGSERIAL PRIMARY KEY,
  site_url      TEXT NOT NULL,
  pages_checked INT NOT NULL DEFAULT 0,
  score         INT NOT NULL DEFAULT 0,
  findings      JSONB NOT NULL DEFAULT '[]'::jsonb,
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seo_audit_checked ON ipy_seo_audit(checked_at DESC);

-- The audit fetches real pages, so it needs to know where the site lives.
-- Blank disables the job rather than guessing a domain and reporting on
-- somebody else's site.
INSERT INTO ipy_setting (key, value, category, label, description) VALUES
  ('seo.site_url', '""'::jsonb, 'seo',
   'Public website URL',
   'The live site to audit each day, e.g. https://www.ipropy.com. Leave blank to switch the daily SEO audit off.'),
  ('seo.audit_enabled', 'true'::jsonb, 'seo',
   'Run the daily SEO audit',
   'Fetches the live pages once a day and scores titles, descriptions, headings, canonicals, structured data and alt text.')
ON CONFLICT (key) DO NOTHING;
