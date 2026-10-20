-- 20 October 2026, the owner: "would the Jev bill come out lots on me?" and "how much worked, how much left".
--
-- One row per day and kind of question Jev was asked, so the cost and the progress can be read instead of guessed.
CREATE TABLE IF NOT EXISTS ipy_market_jev_usage (
  day           DATE NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('post', 'pair')),
  calls         INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  input_tokens  BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind)
);

-- A pairing Jev could not answer. Without this, one odd message was asked about at every visit for ever, and three of them
-- in a row made the checker believe Jev was down and stop for everybody.
CREATE TABLE IF NOT EXISTS ipy_market_pair_failed (
  want_listing_id UUID NOT NULL REFERENCES ipy_market_listing(id) ON DELETE CASCADE,
  have_listing_id UUID NOT NULL REFERENCES ipy_market_listing(id) ON DELETE CASCADE,
  attempts        INTEGER NOT NULL DEFAULT 1,
  last_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (want_listing_id, have_listing_id)
);
