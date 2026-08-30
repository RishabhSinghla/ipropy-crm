-- Refresh tokens stop being readable, and stop being reusable forever.
--
-- They were stored exactly as issued, so anyone who read `ipy_session` held a
-- set of working 30-day logins for every member of staff. And `/auth/refresh`
-- never replaced one, so a token that leaked once stayed valid until it expired
-- on its own. A stolen token was a month of access with nothing to notice.
--
-- Now the row holds a SHA-256 of the token, which is the same thing a password
-- column does and for the same reason: the server only ever needs to recognise
-- a token, never to reproduce one.
--
-- **Nobody is signed out by this.** The plaintext is right there, so it is
-- hashed in place before the column goes. A migration that logs the whole team
-- out on a Tuesday morning is not a security improvement anybody thanks you for.
--
-- `replaced_by` is what makes rotation safe rather than merely correct. Two
-- browser tabs refreshing at the same moment both present the same old token;
-- the second one has to be answered, not treated as theft. So a rotated token
-- keeps a pointer to its successor for a short grace window, and only a
-- presentation *after* that window is treated as a stolen token — which then
-- revokes every session that user has, because a token being replayed means
-- somebody else has it.

ALTER TABLE ipy_session ADD COLUMN IF NOT EXISTS token_hash TEXT;
ALTER TABLE ipy_session ADD COLUMN IF NOT EXISTS replaced_by UUID REFERENCES ipy_session(id) ON DELETE SET NULL;
ALTER TABLE ipy_session ADD COLUMN IF NOT EXISTS rotated_at TIMESTAMPTZ;

-- Hash what is already there, so every current session keeps working.
UPDATE ipy_session
   SET token_hash = encode(sha256(refresh_token::bytea), 'hex')
 WHERE token_hash IS NULL
   AND refresh_token IS NOT NULL;

-- Any row that somehow has neither is unusable; drop it rather than leave a
-- session nothing can ever match.
DELETE FROM ipy_session WHERE token_hash IS NULL;

ALTER TABLE ipy_session ALTER COLUMN token_hash SET NOT NULL;

-- The lookup is by hash on every refresh, so it needs to be an index, and a
-- unique one: two sessions sharing a hash would be a collision or a bug, and
-- either way the wrong session must never be returned.
CREATE UNIQUE INDEX IF NOT EXISTS ipy_session_token_hash_idx ON ipy_session (token_hash);

-- And the plaintext goes. This is the whole point of the migration.
ALTER TABLE ipy_session DROP COLUMN IF EXISTS refresh_token;
