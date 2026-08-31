-- A place to paste the Sentry address.
--
-- Error reporting is the one thing standing between a rep hitting a bug and
-- anybody finding out about it. Today the only path is somebody remembering to
-- mention it, and the reps least confident with the software are the least
-- likely to mention anything.
--
-- The DSN goes in `config` rather than `credentials` on purpose. It is not a
-- secret: it sits in the JavaScript of every website that uses one, and it can
-- only write events, never read them. Encrypting it would imply a risk that is
-- not there and would stop the web app reading it, which it needs to.
--
-- Inactive until somebody pastes an address, like every other integration.

-- Existence test rather than ON CONFLICT: the unique index is on
-- (provider, label), not provider alone, so an inference clause naming only
-- provider fails with 42P10 — "no unique or exclusion constraint matching",
-- which reads like a missing constraint rather than the wrong one.
INSERT INTO ipy_integration (provider, kind, label, is_active, config, credentials)
SELECT 'sentry', 'ops', 'Error reporting (Sentry)', false, '{}'::jsonb, '{}'::jsonb
 WHERE NOT EXISTS (SELECT 1 FROM ipy_integration WHERE provider = 'sentry');
