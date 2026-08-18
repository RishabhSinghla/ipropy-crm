-- Getting back in without an administrator.
--
-- Until now the only way to recover a forgotten password was an admin resetting
-- it for you, which works for everyone except the admin. He is the only one, so
-- a forgotten password locked him out of his own CRM permanently, with no path
-- back that did not involve editing the database by hand.
--
-- The token is stored hashed, exactly like a password. This table is the one an
-- attacker with read access to the database would go for: a plaintext reset
-- token is a working key to any account, and reading rows is a far more common
-- kind of breach than writing them.
CREATE TABLE IF NOT EXISTS ipy_password_reset (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES ipy_user(id) ON DELETE CASCADE,
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  requested_ip text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The lookup is always "find the unused, unexpired row for this hash".
CREATE INDEX IF NOT EXISTS idx_password_reset_lookup
  ON ipy_password_reset (token_hash)
  WHERE used_at IS NULL;

-- Used to rate-limit requests per account, so a stranger cannot fill somebody's
-- inbox by submitting the forgot form in a loop.
CREATE INDEX IF NOT EXISTS idx_password_reset_recent
  ON ipy_password_reset (user_id, created_at DESC);
