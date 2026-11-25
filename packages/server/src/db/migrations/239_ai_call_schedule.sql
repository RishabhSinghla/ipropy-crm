-- Automatic daily AI calling (13 Nov 2026). Everything here ships SWITCHED OFF.
--
-- * ipy_ai_call_schedule: one row per module ('leads', 'properties') plus '_master'.
--   Every row is created with enabled = false, so a deploy can never start a call.
-- * ipy_ai_call_run: one row per module per day for the automatic run. The unique index IS the
--   guard against a double batch after a redeploy: the second insert simply finds the day taken.
-- * ipy_sarvam_batch.origin: automatic batches are not "the user's one running queue", so the
--   one-running-batch-per-user rule now applies to hand-made queues only.

CREATE TABLE ipy_ai_call_schedule (
  module TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  start_time TEXT NOT NULL DEFAULT '10:30' CHECK (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  -- ISO weekdays: 1 = Monday … 7 = Sunday
  days SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5,6}',
  daily_cap INTEGER NOT NULL DEFAULT 50 CHECK (daily_cap BETWEEN 1 AND 500),
  -- Who may be called = the people this saved view shows. No view picked = nobody is called.
  view_id UUID REFERENCES ipy_view(id) ON DELETE SET NULL,
  -- After a real conversation, leave the person alone for this many days.
  rest_days INTEGER NOT NULL DEFAULT 30 CHECK (rest_days BETWEEN 0 AND 365),
  -- No answer / busy / voicemail: try again, at most this many times, at least this many hours apart.
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  retry_hours INTEGER NOT NULL DEFAULT 18 CHECK (retry_hours BETWEEN 1 AND 240),
  -- The CRM user the automatic queue runs as (its permissions decide which records can be called).
  owner_user_id UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES ipy_user(id) ON DELETE SET NULL
);
INSERT INTO ipy_ai_call_schedule(module) VALUES ('_master'), ('leads'), ('properties') ON CONFLICT DO NOTHING;

ALTER TABLE ipy_sarvam_batch ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','auto'));
ALTER TABLE ipy_sarvam_batch ADD COLUMN run_id UUID;
DROP INDEX IF EXISTS sarvam_one_running_batch_per_user;
CREATE UNIQUE INDEX sarvam_one_running_batch_per_user ON ipy_sarvam_batch(user_id) WHERE status = 'running' AND origin = 'manual';
CREATE INDEX IF NOT EXISTS idx_sarvam_queue_record ON ipy_sarvam_queue(record_id);

CREATE TABLE ipy_ai_call_run (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module TEXT NOT NULL,
  run_date DATE NOT NULL,                       -- the India-time day
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule','manual')),
  status TEXT NOT NULL DEFAULT 'planning' CHECK (status IN ('planning','running','done','window_ended','failed','nothing_to_call')),
  batch_id UUID REFERENCES ipy_sarvam_batch(id) ON DELETE SET NULL,
  planned INTEGER NOT NULL DEFAULT 0,
  skipped JSONB NOT NULL DEFAULT '{}'::jsonb,   -- why others were left out: { reason: count }
  message TEXT,
  alerted_at TIMESTAMPTZ,
  created_by UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX ai_call_one_scheduled_run_per_day ON ipy_ai_call_run(module, run_date) WHERE trigger = 'schedule';
CREATE INDEX idx_ai_call_run_date ON ipy_ai_call_run(run_date DESC);

-- One place that turns "how the call ended" into the word shown on the list. Used by the list filters,
-- the list columns, the saved views and the planner, so they can never disagree.
CREATE OR REPLACE FUNCTION ipy_ai_status(call_status TEXT, disposition TEXT, outcome TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN call_status IN ('queued','ringing','connected','in_progress') THEN 'ringing'
    WHEN call_status = 'busy' THEN 'busy'
    WHEN call_status = 'no_answer' THEN 'no_answer'
    WHEN call_status IN ('failed','canceled') THEN 'failed'
    WHEN outcome = 'stop_calling' THEN 'do_not_call'
    WHEN outcome = 'voicemail' THEN 'voicemail'
    WHEN outcome = 'wrong_number' THEN 'wrong_number'
    WHEN outcome = 'silent' THEN 'no_answer'
    WHEN outcome IN ('not_interested','already_bought') THEN 'not_interested'
    WHEN outcome = 'callback' OR lower(coalesce(disposition,'')) ~ 'call ?back' THEN 'callback'
    WHEN lower(coalesce(disposition,'')) ~ 'not interested' THEN 'not_interested'
    WHEN lower(coalesce(disposition,'')) ~ 'interested' THEN 'interested'
    WHEN call_status = 'completed' THEN 'answered'
    ELSE 'failed'
  END
$$;
