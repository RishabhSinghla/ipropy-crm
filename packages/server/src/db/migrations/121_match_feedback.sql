-- A salesperson's decision about a proposed match is data, not browser state.
CREATE TABLE IF NOT EXISTS ipy_match_feedback (
  source_record_id UUID NOT NULL REFERENCES ipy_record(id) ON DELETE CASCADE,
  target_record_id UUID NOT NULL REFERENCES ipy_record(id) ON DELETE CASCADE,
  decision         TEXT NOT NULL CHECK (decision IN ('shortlisted','not_suitable','follow_up')),
  decided_by       UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  decided_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_record_id, target_record_id)
);
