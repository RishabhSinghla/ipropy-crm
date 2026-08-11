-- A site visit: which property, and the window of time its photos were shot in.
--
-- The problem this solves is that the identity of a property is known at the
-- moment the shutter is pressed and thrown away immediately. Everything after
-- that — sorting, sending, filing, captioning — is a person re-deriving a fact
-- they already had. A session records it once, at the gate, and every photo
-- taken inside its window belongs to it.
--
-- Matching is by time, not by location. GPS is recorded and is good for
-- segmenting a day into visits, but it cannot name the property: adjacent
-- builder floors in Greenfield are ten to twenty metres apart, well inside the
-- error of a phone fix. The property comes from the person; the clock does the
-- rest.

CREATE TABLE IF NOT EXISTS ipy_shoot_session (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The property being shot. Nullable because a session can legitimately open
  -- before the record exists (offline at the gate, record created on sync),
  -- and because a visit to something not yet in inventory is still worth
  -- keeping rather than discarding.
  record_id     UUID REFERENCES ipy_record(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES ipy_user(id) ON DELETE CASCADE,

  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Null while open. Nothing requires the phone to close a session: the next
  -- one closes it, or the sweep does. Relying on someone pressing "finish"
  -- after ten site visits in the sun is how photos end up unattributed.
  ended_at      TIMESTAMPTZ,

  -- Where the visit happened. Recorded for grouping, review and later reverse
  -- geocoding — never as the thing that decides which property this is.
  lat           NUMERIC(9,6),
  lng           NUMERIC(9,6),
  accuracy_m    NUMERIC(8,2),

  -- What was said at the gate, and what it became. The transcript is parsed
  -- into fields for review rather than written straight onto the record: a
  -- misheard price is worse than an empty one.
  voice_note_id UUID REFERENCES ipy_attachment(id) ON DELETE SET NULL,
  transcript    TEXT,
  parsed        JSONB NOT NULL DEFAULT '{}'::jsonb,

  --   capturing  open, photos may still arrive
  --   ready      closed, waiting for the media to be matched and reviewed
  --   reviewed   a human has confirmed the parsed fields
  status        TEXT NOT NULL DEFAULT 'capturing'
                CHECK (status IN ('capturing', 'ready', 'reviewed')),

  -- Idempotency key minted on the device before the request is queued.
  --
  -- The capture screen writes to IndexedDB first and syncs when there is
  -- signal, because Greenfield sites often have none. A queued request will be
  -- retried, and may be retried after it actually succeeded but before the
  -- response got back — so "create a session" has to be safe to ask for twice.
  -- Unique rather than a primary key so the server still owns the id.
  client_ref    TEXT NOT NULL UNIQUE,
  device_label  TEXT,

  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Closing the previous session and finding the open one are the two hot reads,
-- and both are "this user's open session".
CREATE INDEX IF NOT EXISTS idx_shoot_session_open
  ON ipy_shoot_session(user_id, started_at DESC)
  WHERE ended_at IS NULL;

-- The match query is "which session's window contains this photo's timestamp",
-- which is a range scan over one user's sessions.
CREATE INDEX IF NOT EXISTS idx_shoot_session_window
  ON ipy_shoot_session(user_id, started_at, ended_at);

CREATE INDEX IF NOT EXISTS idx_shoot_session_record
  ON ipy_shoot_session(record_id);

-- Which session an attachment was matched to, and how confident that was.
-- Nullable throughout: files uploaded the ordinary way, from a desk, have no
-- session and never will.
ALTER TABLE ipy_attachment
  ADD COLUMN IF NOT EXISTS shoot_session_id UUID REFERENCES ipy_shoot_session(id) ON DELETE SET NULL;

-- When the photo was actually taken, as opposed to when it finished uploading.
-- These differ by hours: the phone shoots at a site with no signal and the
-- bytes arrive that evening over wi-fi. Matching on created_at would file every
-- photo of the day against whichever property was last visited.
ALTER TABLE ipy_attachment
  ADD COLUMN IF NOT EXISTS captured_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_attachment_session ON ipy_attachment(shoot_session_id);
CREATE INDEX IF NOT EXISTS idx_attachment_captured ON ipy_attachment(captured_at) WHERE captured_at IS NOT NULL;
