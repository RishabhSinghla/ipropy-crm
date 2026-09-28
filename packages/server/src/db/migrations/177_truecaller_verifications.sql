-- A Truecaller verification in flight.
--
-- The browser asks for a nonce, opens Truecaller with it, and Truecaller posts
-- an access token back to our callback URL. The row is what ties those three
-- moments together: without it the callback is an unauthenticated POST from
-- the internet claiming somebody verified, and there would be no way to tell
-- it from a real one.
--
-- Short-lived on purpose. A verification a visitor abandoned is worth nothing
-- ten minutes later, and an unbounded table of them is a free write endpoint.

CREATE TABLE IF NOT EXISTS ipy_truecaller_request (
  nonce       TEXT PRIMARY KEY,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'verified', 'failed')),
  -- What Truecaller handed back about the person, exactly as it arrived. Their
  -- field names are not documented anywhere reachable, so the whole profile is
  -- kept and the reader is tolerant rather than the writer being a guess.
  profile     JSONB,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_truecaller_request_expiry
  ON ipy_truecaller_request (expires_at);
