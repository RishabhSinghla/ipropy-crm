-- "Sign in with a passkey only": a person who turns it on can no longer sign in
-- with their password, so a stolen, guessed or phished password opens nothing.
-- Off for everybody until they choose it, so nobody is locked out by this
-- migration. An admin resetting that person's password turns it off again,
-- which is the way back in when a phone is lost.
ALTER TABLE ipy_user ADD COLUMN IF NOT EXISTS password_login_disabled BOOLEAN NOT NULL DEFAULT false;
