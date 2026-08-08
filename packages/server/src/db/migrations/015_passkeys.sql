-- ===========================================================================
-- iPropy CRM — 015: passkeys (Face ID / Touch ID / Android biometrics)
--
-- A salesperson opens the CRM on a phone dozens of times a day; typing a
-- password each time is the reason people pick weak ones. WebAuthn moves the
-- check to the device's own biometric sensor — the fingerprint never leaves
-- the phone, and the server only ever sees a public key.
--
-- Notes on the columns:
--  * `credential_id` is the browser's handle for the key and is globally
--    unique, so it doubles as the lookup for a usernameless sign-in — the
--    user does not have to type anything before Face ID runs.
--  * `counter` is the authenticator's signature count. It only ever goes up;
--    a value that goes backwards means the credential has been cloned, which
--    is the one signal WebAuthn gives us about a compromised key.
--  * `transports` records how the key is reachable (internal, usb, hybrid…)
--    so the browser can prompt for the right thing rather than guessing.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS ipy_webauthn_credential (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES ipy_user(id) ON DELETE CASCADE,
  credential_id  TEXT NOT NULL UNIQUE,
  public_key     TEXT NOT NULL,
  counter        BIGINT NOT NULL DEFAULT 0,
  transports     JSONB NOT NULL DEFAULT '[]'::jsonb,
  device_label   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webauthn_user ON ipy_webauthn_credential(user_id);

-- Short-lived challenges. Kept server-side rather than in a cookie so a
-- replayed or attacker-chosen challenge cannot be accepted, and deleted on
-- use — a challenge is valid exactly once.
CREATE TABLE IF NOT EXISTS ipy_webauthn_challenge (
  challenge   TEXT PRIMARY KEY,
  user_id     UUID REFERENCES ipy_user(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webauthn_challenge_expiry ON ipy_webauthn_challenge(expires_at);
