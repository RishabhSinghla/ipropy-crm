-- The market feed: deals other dealers post in WhatsApp groups.
--
-- 11 October 2026, the owner: requirements and inventory arrive in dealer
-- groups all day and nobody can hold them in their head, so a lead goes
-- unmatched while the flat it wants sits in a group chat. Each row is one
-- deal, stored once however many groups it was posted in (the fingerprint),
-- with the groups it came from kept beside it. Nothing here is a CRM record;
-- a deal becomes one only when somebody decides it should.
CREATE TABLE IF NOT EXISTS ipy_market_post (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint      TEXT NOT NULL UNIQUE,
  body             TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'unknown' CHECK (kind IN ('have', 'want', 'unknown')),
  bhk              INTEGER,
  price_min_lakh   NUMERIC,
  price_max_lakh   NUMERIC,
  localities       TEXT[] NOT NULL DEFAULT '{}',
  poster_name      TEXT,
  poster_phone     TEXT,
  groups           TEXT[] NOT NULL DEFAULT '{}',
  first_posted_at  TIMESTAMPTZ,
  last_posted_at   TIMESTAMPTZ,
  seen_count       INTEGER NOT NULL DEFAULT 1,
  imported_by      UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_market_post_recent ON ipy_market_post (last_posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_post_localities ON ipy_market_post USING gin (localities);
