-- Jev reads the market feed, and a deal can be matched against another deal.
--
-- 12 October 2026, the owner: the dealer-group tool that ran outside the CRM
-- must live inside it. Three things need a place to be remembered:
--   * what Jev (TypeSafe's decision model) made of each post, and whether it
--     has looked yet — the word lists in readPost.ts stay as the fallback;
--   * the sector / block and plot size a post names, which is what a plot deal
--     is actually matched on (a locality picklist cannot say "Sector 85, 250 yd");
--   * whether the team has been told about a deal, so reading it later with
--     Jev never rings anybody twice.
ALTER TABLE ipy_market_post
  ADD COLUMN IF NOT EXISTS category       TEXT,
  ADD COLUMN IF NOT EXISTS poster_role    TEXT,
  ADD COLUMN IF NOT EXISTS urgency        NUMERIC,
  ADD COLUMN IF NOT EXISTS is_noise       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS jev_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS jev_attempts   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS alerted_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS places         TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS size_sqyd      INTEGER,
  -- sectors/blocks and the business's own localities, lower-cased, so two posts
  -- about the same area can be found with one indexed overlap test.
  ADD COLUMN IF NOT EXISTS place_keys      TEXT[] NOT NULL DEFAULT '{}',
  -- 0 = read before sectors, sizes and categories were understood; the background
  -- reader re-reads those without any network call and moves them to 1.
  ADD COLUMN IF NOT EXISTS read_version    INTEGER NOT NULL DEFAULT 0;

-- Everything already in the feed was alerted (or deliberately not) at import.
-- Without this, Jev reading the backlog would tell owners about March.
UPDATE ipy_market_post SET alerted_at = created_at WHERE alerted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_market_post_unread_by_jev
  ON ipy_market_post (last_posted_at DESC NULLS LAST) WHERE jev_checked_at IS NULL;
UPDATE ipy_market_post SET place_keys = ARRAY(SELECT lower(x) FROM unnest(localities) x) WHERE place_keys = '{}';
CREATE INDEX IF NOT EXISTS idx_market_post_place_keys ON ipy_market_post USING gin (place_keys);

-- One row per pairing somebody has acted on: buyer's post, seller's post, what happened.
-- The pairings themselves are never stored — they are worked out fresh from the posts,
-- so a better matcher tomorrow improves yesterday's feed without a rebuild.
CREATE TABLE IF NOT EXISTS ipy_market_deal (
  want_post_id UUID NOT NULL REFERENCES ipy_market_post(id) ON DELETE CASCADE,
  have_post_id UUID NOT NULL REFERENCES ipy_market_post(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'new'
               CHECK (status IN ('new', 'called', 'meeting', 'won', 'lost', 'dismissed')),
  note         TEXT,
  updated_by   UUID,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (want_post_id, have_post_id)
);
