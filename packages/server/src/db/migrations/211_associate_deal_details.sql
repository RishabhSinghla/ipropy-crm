-- The team's own copy of a dealer's deal: the details they fill in, a row they
-- duplicated, or one they removed from the list.
--
-- Why a table of its own and not columns on `ipy_market_listing`: a listing is
-- what the parser read out of a WhatsApp post, and the parser deletes and
-- re-inserts a post's listings every time the post is re-read (listings.ts), so
-- anything typed onto one would vanish on the next pass. This row is written the
-- first time somebody touches a listing, carries its own copy of the words, and
-- from then on stands in for it — matched by (post, position in the post).
--
-- `extra` holds the key/values an admin adds to the form in Admin -> Layouts, so
-- adding a field to the form needs no migration.
CREATE TABLE IF NOT EXISTS ipy_associate_deal (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id         UUID NOT NULL REFERENCES ipy_record(id) ON DELETE CASCADE,
  post_id           UUID,
  -- The listing this one replaces. NULL for a duplicate, which replaces nothing.
  source_ord        INTEGER,
  kind              TEXT NOT NULL CHECK (kind IN ('have', 'want')),
  purpose           TEXT NOT NULL CHECK (purpose IN ('sale', 'rent')),
  is_deleted        BOOLEAN NOT NULL DEFAULT false,
  summary           TEXT NOT NULL DEFAULT '',
  body              TEXT NOT NULL DEFAULT '',
  groups            TEXT[] NOT NULL DEFAULT '{}',
  seen_count        INTEGER NOT NULL DEFAULT 1,
  posted_at         TIMESTAMPTZ,
  house_no          TEXT,
  locality          TEXT,
  category          TEXT,
  project           TEXT,
  facing            TEXT,
  floor             TEXT,
  portion           TEXT,
  bhk               INTEGER,
  size_sqyd         NUMERIC,
  price_min_lakh    NUMERIC,
  price_max_lakh    NUMERIC,
  next_followup_at  DATE,
  property_status   TEXT,
  lost_reason       TEXT,
  source            TEXT,
  extra             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by        UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_associate_deal_record
  ON ipy_associate_deal (record_id) WHERE NOT is_deleted;

-- One stand-in per listing, so touching the same row twice edits it rather than
-- adding a second.
CREATE UNIQUE INDEX IF NOT EXISTS idx_associate_deal_source
  ON ipy_associate_deal (record_id, post_id, source_ord) WHERE source_ord IS NOT NULL;
