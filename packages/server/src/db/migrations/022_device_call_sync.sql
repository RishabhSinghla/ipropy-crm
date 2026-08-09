-- ===========================================================================
-- iPropy CRM — 022: call logging from the salesperson's own phone
--
-- Cloud telephony needs a KYC'd Indian virtual number, which takes days and
-- costs per minute. Meanwhile every call the team already makes on their own
-- handsets is invisible to the CRM.
--
-- This is the other half: a companion Android app reads the system call log and
-- posts it here. No telephony account, no per-minute cost, and it captures the
-- calls that actually happen rather than only the ones placed through a dialer
-- nobody remembers to use.
--
-- Recordings piggyback on the OEM recorder. Android 10 closed the third-party
-- recording API, but Xiaomi/Realme/Samsung/OnePlus builds still write their own
-- recordings to a folder the app can watch and upload.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS ipy_device (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES ipy_user(id) ON DELETE CASCADE,
  label         TEXT NOT NULL DEFAULT 'Android phone',
  platform      TEXT NOT NULL DEFAULT 'android',
  -- Only the hash is stored. The token is shown once, at pairing, and is a
  -- bearer credential for a long-lived background sync — treating it like a
  -- password is the minimum.
  token_hash    TEXT NOT NULL,
  token_preview TEXT,
  -- The phone's own number, so an outbound call's `from` can be attributed
  -- even when the user's profile number is a different line.
  phone_number  TEXT,
  app_version   TEXT,
  model         TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  last_sync_at  TIMESTAMPTZ,
  last_sync_count INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (token_hash)
);
CREATE INDEX IF NOT EXISTS idx_device_user ON ipy_device(user_id, is_active);

-- ---------------------------------------------------------------------------
-- Call table additions
-- ---------------------------------------------------------------------------

-- 'api' (placed through a provider), 'device' (synced from a handset),
-- 'manual' (typed in by a person).
ALTER TABLE ipy_call ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'api';
ALTER TABLE ipy_call ADD COLUMN IF NOT EXISTS device_id UUID REFERENCES ipy_device(id) ON DELETE SET NULL;

-- The handset's own call-log row id, scoped to the device. A phone re-syncing
-- the same window (a reinstall, a manual "sync now", a retried batch) must not
-- produce a second copy of every call — this is what makes the ingest
-- idempotent, and it is enforced by the index below rather than by the client
-- remembering what it already sent.
ALTER TABLE ipy_call ADD COLUMN IF NOT EXISTS external_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_call_device_external
  ON ipy_call(device_id, external_id)
  WHERE device_id IS NOT NULL AND external_id IS NOT NULL;

-- Set when a rep has answered "what happened?" — distinct from a disposition
-- inferred from call status, and the thing pipeline reporting actually needs.
ALTER TABLE ipy_call ADD COLUMN IF NOT EXISTS disposition_at TIMESTAMPTZ;
ALTER TABLE ipy_call ADD COLUMN IF NOT EXISTS follow_up_at TIMESTAMPTZ;

-- 'missed' already exists in the direction check; a device sync also reports
-- rejected and blocked calls, which are neither inbound nor outbound in the
-- provider sense but matter to a salesperson looking at a lead.
ALTER TABLE ipy_call DROP CONSTRAINT IF EXISTS ipy_call_direction_check;
ALTER TABLE ipy_call ADD CONSTRAINT ipy_call_direction_check
  CHECK (direction IN ('inbound','outbound','missed','rejected','blocked','unknown'));

CREATE INDEX IF NOT EXISTS idx_call_needs_disposition
  ON ipy_call(user_id, started_at DESC)
  WHERE disposition IS NULL AND status = 'completed';

-- ---------------------------------------------------------------------------
-- Dispositions
--
-- Nothing to seed: `call_disposition` already exists with thirteen values from
-- the module seed, and they are better than a second opinion would be
-- ("Not Reachable", "Switched Off" and "Busy" are three different coaching
-- conversations, where a generic "Not Answered" is one).
--
-- The gap was never the vocabulary, it was that nothing asked the question.
-- That is what the disposition prompt in the call UI is for.
-- ---------------------------------------------------------------------------
