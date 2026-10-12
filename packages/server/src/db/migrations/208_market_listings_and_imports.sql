-- A message is many properties; an export is uploaded once and then topped up.
--
-- 12 October 2026, the owner, against his own call sheet: a broker's list of
-- twenty plots was one "deal" carrying the first size and every sector it
-- mentioned, so it matched everybody. And a group's export is the whole history
-- each time, so it must be read once and then only from where it left off.

-- One row per property offered or wanted inside a message. Matching, and the four
-- tabs on an Associate, read these; ipy_market_post keeps the message itself.
CREATE TABLE IF NOT EXISTS ipy_market_listing (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id        UUID NOT NULL REFERENCES ipy_market_post(id) ON DELETE CASCADE,
  ord            INTEGER NOT NULL DEFAULT 0,
  kind           TEXT NOT NULL CHECK (kind IN ('have', 'want')),
  purpose        TEXT NOT NULL DEFAULT 'sale' CHECK (purpose IN ('sale', 'rent')),
  category       TEXT,
  bhk            INTEGER,
  size_sqyd      INTEGER,
  price_min_lakh NUMERIC,
  price_max_lakh NUMERIC,
  place_keys     TEXT[] NOT NULL DEFAULT '{}',
  project        TEXT,
  facing         TEXT,
  floor          TEXT,
  summary        TEXT NOT NULL DEFAULT '',
  source         TEXT NOT NULL DEFAULT 'rules' CHECK (source IN ('rules', 'ai')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (post_id, ord)
);
CREATE INDEX IF NOT EXISTS idx_market_listing_places ON ipy_market_listing USING gin (place_keys);
CREATE INDEX IF NOT EXISTS idx_market_listing_kind ON ipy_market_listing (kind, purpose);

ALTER TABLE ipy_market_post
  ADD COLUMN IF NOT EXISTS listings_source     TEXT,
  ADD COLUMN IF NOT EXISTS listings_checked_at TIMESTAMPTZ,
  -- Every mobile the message names, first first; the first is the number to ring.
  ADD COLUMN IF NOT EXISTS phones              TEXT[] NOT NULL DEFAULT '{}',
  -- Set once the message has been written into the dealer's notes.
  ADD COLUMN IF NOT EXISTS noted_at            TIMESTAMPTZ,
  -- A long broadcast waits for the AI model's read before it is written into anyone's notes,
  -- so the note carries the right tabs; it gives up waiting after two failed tries.
  ADD COLUMN IF NOT EXISTS ai_pending           BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_attempts          INTEGER NOT NULL DEFAULT 0;

-- Each time a message was seen in a group. A deal forwarded into ten groups is one post
-- seen ten times; the same line of the same export read twice is seen once.
CREATE TABLE IF NOT EXISTS ipy_market_post_seen (
  post_id   UUID NOT NULL REFERENCES ipy_market_post(id) ON DELETE CASCADE,
  group_name TEXT NOT NULL,
  posted_at TIMESTAMPTZ,
  sender    TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_market_seen_once
  ON ipy_market_post_seen (post_id, group_name, coalesce(posted_at, 'epoch'::timestamptz), sender);

-- Where each group's history has been read up to, so the next export is read from there.
CREATE TABLE IF NOT EXISTS ipy_market_group (
  name            TEXT PRIMARY KEY,
  read_up_to      TIMESTAMPTZ,
  messages_seen   INTEGER NOT NULL DEFAULT 0,
  last_import_at  TIMESTAMPTZ
);

-- One row per file dropped on the Dealer groups page: what it was, what came of it.
CREATE TABLE IF NOT EXISTS ipy_market_import (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_name   TEXT NOT NULL,
  file_name    TEXT NOT NULL DEFAULT '',
  file_hash    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'duplicate')),
  messages     INTEGER NOT NULL DEFAULT 0,
  deals        INTEGER NOT NULL DEFAULT 0,
  new_deals    INTEGER NOT NULL DEFAULT 0,
  repeats      INTEGER NOT NULL DEFAULT 0,
  skipped_old  INTEGER NOT NULL DEFAULT 0,
  listings     INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_market_import_recent ON ipy_market_import (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_import_hash ON ipy_market_import (file_hash) WHERE status = 'done';

-- A second opinion on a pairing: Jev's probability that the offer really answers the requirement.
CREATE TABLE IF NOT EXISTS ipy_market_pair_check (
  want_listing_id UUID NOT NULL REFERENCES ipy_market_listing(id) ON DELETE CASCADE,
  have_listing_id UUID NOT NULL REFERENCES ipy_market_listing(id) ON DELETE CASCADE,
  fit             NUMERIC NOT NULL,
  checked_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (want_listing_id, have_listing_id)
);

-- "Not a real match" is its own answer, distinct from "not for us": it teaches the matcher.
ALTER TABLE ipy_market_deal DROP CONSTRAINT IF EXISTS ipy_market_deal_status_check;
ALTER TABLE ipy_market_deal ADD CONSTRAINT ipy_market_deal_status_check
  CHECK (status IN ('new', 'called', 'meeting', 'won', 'lost', 'dismissed', 'bad_match'));
-- A pairing is now of listings, not messages. The old message ids stay readable.
-- Two listings of the same two messages are two pairings, so the message pair can no longer be the key.
ALTER TABLE ipy_market_deal DROP CONSTRAINT IF EXISTS ipy_market_deal_pkey;
ALTER TABLE ipy_market_deal ALTER COLUMN want_post_id DROP NOT NULL, ALTER COLUMN have_post_id DROP NOT NULL;
ALTER TABLE ipy_market_deal
  ADD COLUMN IF NOT EXISTS want_listing_id UUID REFERENCES ipy_market_listing(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS have_listing_id UUID REFERENCES ipy_market_listing(id) ON DELETE CASCADE;
-- Messages pairs recorded before pairings were of listings stay readable and still unique.
CREATE UNIQUE INDEX IF NOT EXISTS idx_market_deal_legacy ON ipy_market_deal (want_post_id, have_post_id) WHERE want_listing_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_market_deal_listings
  ON ipy_market_deal (want_listing_id, have_listing_id) WHERE want_listing_id IS NOT NULL;

-- A message written into a dealer's notes carries the post it came from, once.
ALTER TABLE ipy_comment ADD COLUMN IF NOT EXISTS market_post_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_market_post ON ipy_comment (market_post_id, record_id) WHERE market_post_id IS NOT NULL;

-- Phones for what is already held.
UPDATE ipy_market_post SET phones = ARRAY[poster_phone] WHERE poster_phone IS NOT NULL AND phones = '{}';
