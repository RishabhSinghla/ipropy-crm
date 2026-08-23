-- "Not the same person", remembered.
--
-- The duplicate suggestion is a guess and it will sometimes be wrong: a father
-- and a son share a surname, a locality and often a budget. Somebody saying no
-- once should end it, or the feature becomes a thing people learn to ignore,
-- which is worse than not having it.
--
-- Stored both ways round by the writer, so whichever record they happened to be
-- looking at when they said no, the answer holds for the pair.
CREATE TABLE IF NOT EXISTS ipy_duplicate_dismissal (
  record_id     UUID NOT NULL REFERENCES ipy_record(id) ON DELETE CASCADE,
  other_id      UUID NOT NULL REFERENCES ipy_record(id) ON DELETE CASCADE,
  dismissed_by  UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  dismissed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (record_id, other_id)
);

COMMENT ON TABLE ipy_duplicate_dismissal IS
  'Pairs somebody has said are different people. The duplicate suggester never offers them again.';
