-- ===========================================================================
-- iPropy CRM — 020: device sends, broadcasts, drip sequences, richer auto-replies
--
-- The WhatsApp stack has always assumed one way of sending: the Meta Cloud API.
-- That assumption is what made the whole channel wait on a Business account.
-- This migration removes it — a message can now leave either through the API or
-- through the salesperson's own phone (a wa.me hand-off), and everything built
-- on top (broadcasts, sequences, auto-replies) works either way.
--
-- Also fixes a live bug: 019 documented 'blocked' as a message status but never
-- widened the CHECK constraint, so every consent-blocked send raised a
-- constraint violation instead of returning "skipped". A broadcast would have
-- died on its first opted-out recipient rather than stepping over them.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Message statuses
-- ---------------------------------------------------------------------------

ALTER TABLE ipy_message DROP CONSTRAINT IF EXISTS ipy_message_status_check;
ALTER TABLE ipy_message ADD CONSTRAINT ipy_message_status_check CHECK (
  status IN (
    'queued','sent','delivered','read','failed',
    -- refused on consent grounds: a decision to record, not a failure to retry
    'blocked',
    -- handed to the operator's own WhatsApp; we cannot observe what happened next
    'handed_off'
  )
);

-- How the message physically left the building. 'api' is a Cloud API send whose
-- delivery we can track; 'device' was composed here and sent from a human's
-- phone. Kept separate from `provider` because the provider is *who* carried it
-- and this is *how* — a device send has no provider at all.
ALTER TABLE ipy_message ADD COLUMN IF NOT EXISTS sent_via TEXT NOT NULL DEFAULT 'api';

-- ---------------------------------------------------------------------------
-- Broadcasts
--
-- Distinct from `ipy_e_campaigns`, which is the CRM module a marketer plans in.
-- This is one concrete send: an audience frozen at the moment of sending, plus
-- a row per recipient. Before this, `broadcast()` was fire-and-forget — the
-- operator got a notification at the end and no way to answer "who actually
-- received it?".
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ipy_broadcast (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  -- 'api' sends through Meta; 'device' produces a hand-off queue the operator
  -- works through on their phone, one tap per recipient.
  channel_mode    TEXT NOT NULL DEFAULT 'api',
  template_name   TEXT,
  -- Free text is only legal inside an open 24h window, which broadcasts almost
  -- never are; kept for device mode, where Meta's window does not apply.
  body_text       TEXT,
  module_name     TEXT NOT NULL DEFAULT 'leads',
  -- The audience definition, kept so a send can be explained after the fact.
  audience        JSONB NOT NULL DEFAULT '{}'::jsonb,
  campaign_id     UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','scheduled','running','paused','completed','cancelled')),
  scheduled_at    TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  rate_per_second NUMERIC(6,2) NOT NULL DEFAULT 10,
  total_count     INT NOT NULL DEFAULT 0,
  sent_count      INT NOT NULL DEFAULT 0,
  failed_count    INT NOT NULL DEFAULT 0,
  blocked_count   INT NOT NULL DEFAULT 0,
  created_by      UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_broadcast_status ON ipy_broadcast(status, scheduled_at);

CREATE TABLE IF NOT EXISTS ipy_broadcast_recipient (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id  UUID NOT NULL REFERENCES ipy_broadcast(id) ON DELETE CASCADE,
  record_id     UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  handle        TEXT NOT NULL,
  name          TEXT,
  -- Merge values resolved at queue time, so what was sent stays reproducible
  -- even after the record changes.
  params        JSONB NOT NULL DEFAULT '{}'::jsonb,
  rendered_text TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','sent','failed','blocked','skipped','handed_off')),
  error         TEXT,
  message_id    UUID REFERENCES ipy_message(id) ON DELETE SET NULL,
  sent_at       TIMESTAMPTZ,
  UNIQUE (broadcast_id, handle)
);
CREATE INDEX IF NOT EXISTS idx_broadcast_recipient
  ON ipy_broadcast_recipient(broadcast_id, status);

-- ---------------------------------------------------------------------------
-- Drip sequences
--
-- A sequence is steps + delays; an enrolment is one person walking through it.
-- The scheduler advances enrolments, which is why `next_run_at` is indexed and
-- why the step cursor lives on the enrolment rather than being recomputed.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ipy_sequence (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  description    TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT false,
  module_name    TEXT NOT NULL DEFAULT 'leads',
  -- 'manual' | 'on_create' | 'on_condition'
  enrol_trigger  TEXT NOT NULL DEFAULT 'manual',
  enrol_filter   JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Anyone who replies has started a conversation; continuing to drip at them
  -- is the single fastest way to make automation look like spam.
  exit_on_reply  BOOLEAN NOT NULL DEFAULT true,
  -- Lead statuses that end the sequence, e.g. ["Won","Lost","Junk"].
  exit_on_status JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Nothing sends outside these hours; a 2am marketing message costs a number.
  quiet_start    SMALLINT NOT NULL DEFAULT 21,
  quiet_end      SMALLINT NOT NULL DEFAULT 9,
  enrolled_count INT NOT NULL DEFAULT 0,
  created_by     UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ipy_sequence_step (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id   UUID NOT NULL REFERENCES ipy_sequence(id) ON DELETE CASCADE,
  sequence      INT NOT NULL DEFAULT 1,
  -- Time to wait *after the previous step* before this one runs.
  delay_minutes INT NOT NULL DEFAULT 1440,
  channel       TEXT NOT NULL DEFAULT 'whatsapp'
                CHECK (channel IN ('whatsapp','email','task','sms')),
  template_name TEXT,
  subject       TEXT,
  body          TEXT,
  buttons       JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- When the window has closed and no template is set, fall back to queuing a
  -- device hand-off rather than dropping the step silently.
  fallback_to_device BOOLEAN NOT NULL DEFAULT true,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sequence_step ON ipy_sequence_step(sequence_id, sequence);

CREATE TABLE IF NOT EXISTS ipy_sequence_enrolment (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id  UUID NOT NULL REFERENCES ipy_sequence(id) ON DELETE CASCADE,
  record_id    UUID REFERENCES ipy_record(id) ON DELETE CASCADE,
  handle       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','completed','exited','failed','paused')),
  -- Index of the last step that ran; 0 means nothing has run yet.
  current_step INT NOT NULL DEFAULT 0,
  next_run_at  TIMESTAMPTZ,
  exit_reason  TEXT,
  last_error   TEXT,
  enrolled_by  UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One walk through a given sequence per person.
  UNIQUE (sequence_id, record_id)
);
CREATE INDEX IF NOT EXISTS idx_enrolment_due
  ON ipy_sequence_enrolment(next_run_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_enrolment_record ON ipy_sequence_enrolment(record_id);

-- ---------------------------------------------------------------------------
-- Device hand-off queue
--
-- The zero-account path. A row here is a message the CRM has composed and is
-- waiting for a human to send from their own WhatsApp, one tap at a time.
-- Deliberately a queue rather than a link on the record: the value is being
-- able to work a list of forty follow-ups without deciding what to type forty
-- times.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ipy_device_send (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id     UUID REFERENCES ipy_record(id) ON DELETE CASCADE,
  module_name   TEXT,
  handle        TEXT NOT NULL,
  name          TEXT,
  body          TEXT NOT NULL,
  reason        TEXT,
  broadcast_id  UUID REFERENCES ipy_broadcast(id) ON DELETE CASCADE,
  sequence_id   UUID REFERENCES ipy_sequence(id) ON DELETE SET NULL,
  assigned_to   UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','opened','sent','skipped')),
  opened_at     TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_device_send_queue
  ON ipy_device_send(assigned_to, status, created_at);

-- ---------------------------------------------------------------------------
-- Auto-reply rules — branching
--
-- 019 shipped flat rules. Button routing is what turns them into the thing
-- people mean by ManyChat: tapping "Site visit" advances to the next question
-- instead of dead-ending in free text nobody parses.
-- ---------------------------------------------------------------------------

ALTER TABLE ipy_autoreply_rule ADD COLUMN IF NOT EXISTS match_type TEXT NOT NULL DEFAULT 'contains';
-- Maps a quick-reply button id to the rule that should answer it.
ALTER TABLE ipy_autoreply_rule ADD COLUMN IF NOT EXISTS button_routes JSONB NOT NULL DEFAULT '{}'::jsonb;
-- Assign the thread to a human and stop replying automatically.
ALTER TABLE ipy_autoreply_rule ADD COLUMN IF NOT EXISTS handoff BOOLEAN NOT NULL DEFAULT false;
-- Optional attachment sent alongside the reply (a brochure, a floor plan).
ALTER TABLE ipy_autoreply_rule ADD COLUMN IF NOT EXISTS media_url TEXT;
-- Rules reachable only by button route, so they never fire on stray keywords.
ALTER TABLE ipy_autoreply_rule ADD COLUMN IF NOT EXISTS is_routed_only BOOLEAN NOT NULL DEFAULT false;

-- The starter rules become a two-step flow: the site-visit answer now offers
-- days as buttons, and each button has a rule waiting for it.
INSERT INTO ipy_autoreply_rule (name, sequence, trigger_type, keywords, reply_text, is_routed_only)
VALUES
  ('Site visit — weekend', 31, 'keyword', '["weekend"]'::jsonb,
   'Perfect. We have slots on Saturday and Sunday between 11am and 6pm. Which suits you better, {{first_name}}? Our advisor will confirm and share the pin.', true),
  ('Site visit — weekday', 32, 'keyword', '["weekday"]'::jsonb,
   'Noted. Weekdays are quieter, so you get more time with the advisor. Which day works — and morning or evening?', true)
ON CONFLICT DO NOTHING;

UPDATE ipy_autoreply_rule
SET buttons = '[{"id":"visit_weekend","title":"This weekend"},{"id":"visit_weekday","title":"A weekday"}]'::jsonb,
    button_routes = jsonb_build_object(
      'visit_weekend', (SELECT id::text FROM ipy_autoreply_rule WHERE name = 'Site visit — weekend'),
      'visit_weekday', (SELECT id::text FROM ipy_autoreply_rule WHERE name = 'Site visit — weekday')
    )
WHERE name = 'Site visit'
  AND EXISTS (SELECT 1 FROM ipy_autoreply_rule WHERE name = 'Site visit — weekend');
