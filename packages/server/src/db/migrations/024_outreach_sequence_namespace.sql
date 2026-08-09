-- ===========================================================================
-- iPropy CRM — 024: give outreach sequences their own table namespace
--
-- `ipy_sequence` has existed since 001 and is the auto-number counter table.
-- Migration 020 used CREATE TABLE IF NOT EXISTS with the same name for drip
-- sequences, so PostgreSQL correctly kept the counter table and the outreach
-- API later tried to read columns that could never exist.  Keep numbering
-- untouched and move follow-up automation to explicit outreach tables.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS ipy_outreach_sequence (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  description     TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT false,
  module_name     TEXT NOT NULL DEFAULT 'leads',
  enrol_trigger   TEXT NOT NULL DEFAULT 'manual',
  enrol_filter    JSONB NOT NULL DEFAULT '{}'::jsonb,
  exit_on_reply   BOOLEAN NOT NULL DEFAULT true,
  exit_on_status  JSONB NOT NULL DEFAULT '[]'::jsonb,
  quiet_start     SMALLINT NOT NULL DEFAULT 21,
  quiet_end       SMALLINT NOT NULL DEFAULT 9,
  enrolled_count  INT NOT NULL DEFAULT 0,
  created_by      UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ipy_outreach_sequence_trigger_check
    CHECK (enrol_trigger IN ('manual','on_create','on_condition')),
  CONSTRAINT ipy_outreach_sequence_quiet_start_check
    CHECK (quiet_start BETWEEN 0 AND 23),
  CONSTRAINT ipy_outreach_sequence_quiet_end_check
    CHECK (quiet_end BETWEEN 0 AND 23)
);

CREATE TABLE IF NOT EXISTS ipy_outreach_sequence_step (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id         UUID NOT NULL REFERENCES ipy_outreach_sequence(id) ON DELETE CASCADE,
  sequence            INT NOT NULL DEFAULT 1,
  delay_minutes       INT NOT NULL DEFAULT 1440,
  channel             TEXT NOT NULL DEFAULT 'whatsapp'
                      CHECK (channel IN ('whatsapp','email','task','sms')),
  template_name       TEXT,
  subject             TEXT,
  body                TEXT,
  buttons             JSONB NOT NULL DEFAULT '[]'::jsonb,
  fallback_to_device  BOOLEAN NOT NULL DEFAULT true,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ipy_outreach_sequence_step_number_check CHECK (sequence > 0),
  CONSTRAINT ipy_outreach_sequence_step_delay_check CHECK (delay_minutes >= 0),
  UNIQUE (sequence_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_outreach_sequence_step
  ON ipy_outreach_sequence_step(sequence_id, sequence);

CREATE TABLE IF NOT EXISTS ipy_outreach_sequence_enrolment (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id    UUID NOT NULL REFERENCES ipy_outreach_sequence(id) ON DELETE CASCADE,
  record_id      UUID REFERENCES ipy_record(id) ON DELETE CASCADE,
  handle         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','processing','completed','exited','failed','paused')),
  current_step   INT NOT NULL DEFAULT 0,
  next_run_at    TIMESTAMPTZ,
  claimed_at     TIMESTAMPTZ,
  exit_reason    TEXT,
  last_error     TEXT,
  enrolled_by    UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sequence_id, record_id)
);
CREATE INDEX IF NOT EXISTS idx_outreach_enrolment_due
  ON ipy_outreach_sequence_enrolment(next_run_at, claimed_at)
  WHERE status IN ('active','processing');
CREATE INDEX IF NOT EXISTS idx_outreach_enrolment_record
  ON ipy_outreach_sequence_enrolment(record_id);

-- 020 pointed this optional provenance column at the auto-number table. Keep
-- any pre-existing value intact for auditability: NOT VALID enforces the
-- repaired relationship for every new/changed row without rewriting history.
ALTER TABLE ipy_device_send
  DROP CONSTRAINT IF EXISTS ipy_device_send_sequence_id_fkey;
ALTER TABLE ipy_device_send
  ADD CONSTRAINT ipy_device_send_sequence_id_fkey
  FOREIGN KEY (sequence_id) REFERENCES ipy_outreach_sequence(id) ON DELETE SET NULL
  NOT VALID;
