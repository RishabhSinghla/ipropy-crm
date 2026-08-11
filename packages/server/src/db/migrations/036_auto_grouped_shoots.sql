-- Shoots that nobody opened.
--
-- Migration 034 assumed the property is named at the gate: one tap opens a
-- session, and every photo taken afterwards belongs to it. That is the best
-- possible data when it happens, and it is the wrong thing to *depend* on.
-- Ten site visits a day, in the sun, with an owner talking — the tap is a
-- discipline, and the failure mode of a missed tap is the whole visit's photos
-- landing nowhere.
--
-- So the tap becomes optional. Photos that arrive belonging to no session are
-- grouped by the clock alone: a long enough gap between two shots means the
-- photographer drove somewhere, so the run of photos before it was one place
-- and the run after it was another. That gives a group with no name — which is
-- exactly the state a person can fix in one tap in the evening, looking at the
-- pictures, instead of having to remember anything at the gate.
--
-- The clock cannot supply the name. It never could; that is not what changed.
-- What changed is *when* the name is asked for.

ALTER TABLE ipy_shoot_session
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'manual'
    CHECK (origin IN ('manual', 'auto'));

COMMENT ON COLUMN ipy_shoot_session.origin IS
  'manual: somebody tapped Start and named the property. auto: inferred from a gap between photos, and still nameless until reviewed.';

-- The evening screen's only query: "what did I shoot that still has no name?"
-- Both origins appear in it — a manual session opened offline before its record
-- existed is equally nameless, and equally fixable from the same list.
CREATE INDEX IF NOT EXISTS idx_shoot_session_unassigned
  ON ipy_shoot_session(user_id, started_at DESC)
  WHERE record_id IS NULL;

-- Grouping's own read: this user's auto sessions near a given instant. Narrow
-- on purpose — an auto session that has been given a property is settled, and
-- must not absorb tomorrow's photos.
CREATE INDEX IF NOT EXISTS idx_shoot_session_auto_open
  ON ipy_shoot_session(user_id, started_at)
  WHERE origin = 'auto' AND record_id IS NULL;
