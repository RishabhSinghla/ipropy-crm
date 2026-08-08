-- ===========================================================================
-- iPropy CRM — 016: blog, written in the CRM and published to the website
--
-- The website already reads projects and properties from the CRM's public API,
-- so the blog belongs in the same place: one system of record, no second CMS
-- to log into, and posts inherit the CRM's roles, sharing and workflows for
-- free by being an ordinary module.
--
-- Fields worth explaining:
--  * `slug` is the public URL and is unique among published posts. It is
--    generated from the title but stored, not derived — renaming a post must
--    not silently break every inbound link and social share.
--  * `status` gates visibility. Only 'Published' posts with a `published_at`
--    in the past are ever served publicly (see routes/public.ts), so drafts
--    and scheduled posts are not merely hidden in the UI.
--  * `seo_title` / `seo_description` fall back to the title and excerpt when
--    blank, so a post is never published with an empty <title>.
--  * `reading_minutes` and `word_count` are maintained by a workflow hook
--    rather than computed on read, so listing pages stay cheap.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS ipy_e_blog_posts (
  record_id         UUID PRIMARY KEY REFERENCES ipy_record(id) ON DELETE CASCADE,
  post_number       TEXT,
  title             TEXT NOT NULL,
  slug              TEXT,
  status            TEXT NOT NULL DEFAULT 'Draft',
  excerpt           TEXT,
  body              TEXT,
  cover_image_url   TEXT,
  category          TEXT,
  author_id         UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  project_id        UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  published_at      TIMESTAMPTZ,
  -- SEO / AEO
  seo_title         TEXT,
  seo_description   TEXT,
  seo_keywords      TEXT,
  canonical_url     TEXT,
  -- Answer-engine block: a short, directly quotable answer plus FAQ pairs,
  -- which is what actually gets lifted into AI answers and rich results.
  key_takeaway      TEXT,
  faq               JSONB NOT NULL DEFAULT '[]'::jsonb,
  noindex           BOOLEAN NOT NULL DEFAULT false,
  word_count        INT NOT NULL DEFAULT 0,
  reading_minutes   INT NOT NULL DEFAULT 0,
  view_count        INT NOT NULL DEFAULT 0
);

-- Unique only among posts that are actually reachable: two drafts may share a
-- working title, but two live URLs may never collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_slug_published
  ON ipy_e_blog_posts(slug) WHERE slug IS NOT NULL AND status = 'Published';

CREATE INDEX IF NOT EXISTS idx_blog_published_at ON ipy_e_blog_posts(published_at DESC);
