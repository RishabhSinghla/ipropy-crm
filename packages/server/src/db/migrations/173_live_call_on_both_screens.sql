-- The call a phone is on, as the phone reports it, so the desk can show the
-- same thing the handset does: ringing, then a clock from the moment they
-- picked up, on hold, speaker, mute — and ended.
--
-- `can_control_call` is Android's own answer to "is iPropy this phone's
-- calling app". Only then may an app touch a call that is already running
-- (speaker, mute, hold) or know when the other side answered, so the desk
-- lights those controls from this and nothing else.
ALTER TABLE ipy_device ADD COLUMN IF NOT EXISTS can_control_call BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE ipy_device ADD COLUMN IF NOT EXISTS live_call_direction TEXT;
ALTER TABLE ipy_device ADD COLUMN IF NOT EXISTS live_call_speaker BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE ipy_device ADD COLUMN IF NOT EXISTS live_call_muted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE ipy_device ADD COLUMN IF NOT EXISTS live_call_connected_at TIMESTAMPTZ;
ALTER TABLE ipy_device ADD COLUMN IF NOT EXISTS live_call_ended_at TIMESTAMPTZ;
ALTER TABLE ipy_device ADD COLUMN IF NOT EXISTS live_call_updated_at TIMESTAMPTZ;
