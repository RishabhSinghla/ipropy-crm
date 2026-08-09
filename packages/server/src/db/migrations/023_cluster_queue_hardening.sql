-- ===========================================================================
-- iPropy CRM — 023: durable claims for outreach and render queues
--
-- FOR UPDATE SKIP LOCKED only protects a row while its transaction remains
-- open. The outreach workers perform network and rendering work after the
-- claim, so the claim must be represented in the row itself. `processing` plus
-- `claimed_at` prevents two server instances from sending the same message and
-- also gives a crashed worker a bounded recovery path.
-- ===========================================================================

ALTER TABLE ipy_broadcast_recipient
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
ALTER TABLE ipy_broadcast_recipient
  DROP CONSTRAINT IF EXISTS ipy_broadcast_recipient_status_check;
ALTER TABLE ipy_broadcast_recipient
  ADD CONSTRAINT ipy_broadcast_recipient_status_check CHECK (
    status IN ('pending','processing','sent','failed','blocked','skipped','handed_off')
  );

DROP INDEX IF EXISTS idx_broadcast_recipient;
CREATE INDEX idx_broadcast_recipient
  ON ipy_broadcast_recipient(broadcast_id, status, claimed_at);

ALTER TABLE ipy_sequence_enrolment
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
ALTER TABLE ipy_sequence_enrolment
  DROP CONSTRAINT IF EXISTS ipy_sequence_enrolment_status_check;
ALTER TABLE ipy_sequence_enrolment
  ADD CONSTRAINT ipy_sequence_enrolment_status_check CHECK (
    status IN ('active','processing','completed','exited','failed','paused')
  );

DROP INDEX IF EXISTS idx_enrolment_due;
CREATE INDEX idx_enrolment_due
  ON ipy_sequence_enrolment(next_run_at, claimed_at)
  WHERE status IN ('active','processing');

-- A server can die after it has claimed a render. The scheduler resets these
-- after thirty minutes; this index keeps that recovery probe cheap.
CREATE INDEX IF NOT EXISTS idx_render_running_started
  ON ipy_render_job(started_at)
  WHERE status = 'running';
