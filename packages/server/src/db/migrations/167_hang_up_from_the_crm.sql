-- Ending a call from the desk, and knowing whether this phone can.
--
-- Android only lets the handset's **default phone app** touch a call that is
-- already running. So "End" is not a promise the CRM can make on its own: it
-- depends on a build that carries an InCallService *and* on the rep having
-- said yes when Android asked to make iPropy their phone app.
--
-- The column is what lets the button be drawn dead rather than lying. A phone
-- that cannot end a call must never show an End that does nothing -- that is
-- the failure this repo has written down twice, and it is why the web reads
-- this rather than assuming.
ALTER TABLE ipy_device ADD COLUMN IF NOT EXISTS can_end_call BOOLEAN NOT NULL DEFAULT false;

-- Which call the phone is on, as it last reported. Null means "no call", and
-- a stale row is harmless: the hang-up command carries its own short clock.
ALTER TABLE ipy_device ADD COLUMN IF NOT EXISTS live_call_number TEXT;
ALTER TABLE ipy_device ADD COLUMN IF NOT EXISTS live_call_started_at TIMESTAMPTZ;
ALTER TABLE ipy_device ADD COLUMN IF NOT EXISTS live_call_state TEXT;
