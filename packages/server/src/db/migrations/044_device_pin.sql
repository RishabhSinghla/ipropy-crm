-- Optional four-digit quick unlock, bound to one browser by a random HttpOnly
-- device cookie. Neither the raw device token nor the PIN is stored.

CREATE TABLE IF NOT EXISTS ipy_pin_device (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES ipy_user(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE,
  pin_hash        TEXT NOT NULL,
  label           TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until    TIMESTAMPTZ,
  last_failed_at  TIMESTAMPTZ,
  last_used_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pin_device_user
  ON ipy_pin_device(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pin_device_expiry
  ON ipy_pin_device(expires_at)
  WHERE revoked_at IS NULL;
