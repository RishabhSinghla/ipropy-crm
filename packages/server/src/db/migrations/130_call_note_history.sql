-- Keep every manual correction to a call outcome/note.  A disposition is part
-- of the customer record; silently replacing it makes the call log less
-- trustworthy than an ordinary CRM note, whose revisions are already kept.
CREATE TABLE IF NOT EXISTS ipy_call_revision (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id               UUID NOT NULL REFERENCES ipy_call(id) ON DELETE CASCADE,
  edited_by             UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  previous_disposition  TEXT,
  previous_notes        TEXT,
  new_disposition       TEXT,
  new_notes             TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_call_revision_call
  ON ipy_call_revision(call_id, created_at DESC);
