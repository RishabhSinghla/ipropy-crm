-- One short-lived instruction from the CRM to a rep's own phone.
--
-- Pressing Call at a desk used to hand the number to the laptop, which asked
-- which application should open it — FaceTime, or nothing at all. The rep's
-- phone is the thing that rings customers, so the instruction goes there.
--
-- Deliberately a queue and not a fire-and-forget push: a phone is asleep, out
-- of signal, or has the app swapped out several times an hour, and a command
-- nobody can see the state of is a call that may or may not have happened.
--
-- The `expires_at` column is the rule that matters. A dial instruction is only
-- meaningful for about a minute — a phone that comes back online at 6am must
-- never ring a customer because somebody pressed Call at 7pm. The app filters
-- on it too, so both ends agree without either trusting the other's clock
-- more than its own.
CREATE TABLE IF NOT EXISTS ipy_device_command (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id    UUID NOT NULL REFERENCES ipy_device(id) ON DELETE CASCADE,
  -- Denormalised from the device on purpose: every read is "what is waiting
  -- for *this person*", and it keeps the check that a command never crosses
  -- from one rep to another in one column rather than in a join.
  user_id      UUID NOT NULL REFERENCES ipy_user(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- queued -> delivered -> done | failed, or expired if nothing collected it
  -- in time.
  status       TEXT NOT NULL DEFAULT 'queued',
  -- What the record was about, so the call the phone makes can be filed
  -- against the same person without the app knowing anything about modules.
  module       TEXT,
  record_id    UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  delivered_at TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ
);

-- The only read the phone makes: what is still waiting for me, oldest first.
CREATE INDEX IF NOT EXISTS idx_device_command_waiting
  ON ipy_device_command (device_id, created_at)
  WHERE status = 'queued';
