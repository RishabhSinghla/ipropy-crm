-- ===========================================================================
-- iPropy CRM — 003: workflow engine, communications, telephony, AI, integrations
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Workflow engine
-- ---------------------------------------------------------------------------

CREATE TABLE ipy_workflow (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id         UUID NOT NULL REFERENCES ipy_module(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  description       TEXT,
  trigger           TEXT NOT NULL,
  watch_fields      JSONB NOT NULL DEFAULT '[]'::jsonb,
  conditions        JSONB NOT NULL DEFAULT '{"logic":"AND","conditions":[]}'::jsonb,
  execution_mode    TEXT NOT NULL DEFAULT 'always'
                    CHECK (execution_mode IN ('always','once','once_until_false')),
  schedule          JSONB,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  is_system         BOOLEAN NOT NULL DEFAULT false,
  sequence          INT NOT NULL DEFAULT 0,
  last_run_at       TIMESTAMPTZ,
  next_run_at       TIMESTAMPTZ,
  run_count         BIGINT NOT NULL DEFAULT 0,
  created_by        UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_wf_module ON ipy_workflow(module_id, trigger) WHERE is_active;
CREATE INDEX idx_wf_next_run ON ipy_workflow(next_run_at) WHERE is_active AND trigger = 'scheduled';

CREATE TABLE ipy_workflow_task (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id       UUID NOT NULL REFERENCES ipy_workflow(id) ON DELETE CASCADE,
  type              TEXT NOT NULL,
  name              TEXT NOT NULL,
  sequence          INT NOT NULL DEFAULT 0,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  delay_minutes     INT NOT NULL DEFAULT 0,
  -- relative scheduling: "2 days before {possession_date}"
  delay_field       TEXT,
  delay_direction   TEXT CHECK (delay_direction IN ('before','after')),
  config            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_wftask_wf ON ipy_workflow_task(workflow_id, sequence);

-- Deferred/delayed task execution queue
CREATE TABLE ipy_task_queue (
  id                BIGSERIAL PRIMARY KEY,
  workflow_id       UUID REFERENCES ipy_workflow(id) ON DELETE CASCADE,
  task_id           UUID REFERENCES ipy_workflow_task(id) ON DELETE CASCADE,
  record_id         UUID,
  module_name       TEXT,
  run_at            TIMESTAMPTZ NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','running','done','failed','cancelled')),
  attempts          INT NOT NULL DEFAULT 0,
  max_attempts      INT NOT NULL DEFAULT 3,
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error        TEXT,
  locked_at         TIMESTAMPTZ,
  locked_by         TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ
);
CREATE INDEX idx_queue_due ON ipy_task_queue(status, run_at) WHERE status = 'pending';
CREATE INDEX idx_queue_record ON ipy_task_queue(record_id);

CREATE TABLE ipy_workflow_log (
  id                BIGSERIAL PRIMARY KEY,
  workflow_id       UUID REFERENCES ipy_workflow(id) ON DELETE CASCADE,
  record_id         UUID,
  status            TEXT NOT NULL,
  matched           BOOLEAN NOT NULL DEFAULT false,
  tasks_run         INT NOT NULL DEFAULT 0,
  duration_ms       INT,
  detail            JSONB NOT NULL DEFAULT '{}'::jsonb,
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_wflog_wf ON ipy_workflow_log(workflow_id, created_at DESC);
CREATE INDEX idx_wflog_record ON ipy_workflow_log(record_id, created_at DESC);

-- Tracks 'once' / 'once_until_false' execution state per record
CREATE TABLE ipy_workflow_state (
  workflow_id       UUID NOT NULL REFERENCES ipy_workflow(id) ON DELETE CASCADE,
  record_id         UUID NOT NULL,
  has_run           BOOLEAN NOT NULL DEFAULT false,
  last_matched      BOOLEAN NOT NULL DEFAULT false,
  last_run_at       TIMESTAMPTZ,
  PRIMARY KEY (workflow_id, record_id)
);

-- Assignment rules (round-robin / load-balanced / territory lead routing)
CREATE TABLE ipy_assignment_rule (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id         UUID NOT NULL REFERENCES ipy_module(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  conditions        JSONB NOT NULL DEFAULT '{"logic":"AND","conditions":[]}'::jsonb,
  strategy          TEXT NOT NULL DEFAULT 'round_robin'
                    CHECK (strategy IN ('round_robin','load_balanced','least_busy','specific_user','group','ai_best_fit','territory')),
  -- pool of user ids (or group id for 'group')
  target_users      JSONB NOT NULL DEFAULT '[]'::jsonb,
  target_group_id   UUID REFERENCES ipy_group(id) ON DELETE SET NULL,
  -- for round_robin: index of the last assigned user
  cursor_index      INT NOT NULL DEFAULT 0,
  respect_capacity  BOOLEAN NOT NULL DEFAULT true,
  working_hours_only BOOLEAN NOT NULL DEFAULT false,
  sequence          INT NOT NULL DEFAULT 0,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_assign_module ON ipy_assignment_rule(module_id, sequence) WHERE is_active;

-- SLA policies: first response / follow-up breach tracking
CREATE TABLE ipy_sla_policy (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id         UUID NOT NULL REFERENCES ipy_module(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  conditions        JSONB NOT NULL DEFAULT '{"logic":"AND","conditions":[]}'::jsonb,
  first_response_minutes INT,
  resolution_minutes     INT,
  escalate_to_user_id    UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  escalate_after_minutes INT,
  business_hours_only    BOOLEAN NOT NULL DEFAULT true,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ipy_sla_tracker (
  record_id         UUID PRIMARY KEY REFERENCES ipy_record(id) ON DELETE CASCADE,
  policy_id         UUID REFERENCES ipy_sla_policy(id) ON DELETE SET NULL,
  first_response_due TIMESTAMPTZ,
  first_response_at  TIMESTAMPTZ,
  first_response_breached BOOLEAN NOT NULL DEFAULT false,
  resolution_due     TIMESTAMPTZ,
  resolved_at        TIMESTAMPTZ,
  resolution_breached BOOLEAN NOT NULL DEFAULT false,
  escalated_at       TIMESTAMPTZ
);
CREATE INDEX idx_sla_due ON ipy_sla_tracker(first_response_due) WHERE first_response_at IS NULL;

-- ---------------------------------------------------------------------------
-- Conversations & messaging (WhatsApp / SMS / email / webchat)
-- ---------------------------------------------------------------------------

CREATE TABLE ipy_conversation (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel           TEXT NOT NULL CHECK (channel IN ('whatsapp','sms','email','webchat')),
  handle            TEXT NOT NULL,                 -- E.164 or email address
  contact_name      TEXT,
  record_id         UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  record_module     TEXT,
  assigned_to       UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','pending','resolved','snoozed')),
  unread_count      INT NOT NULL DEFAULT 0,
  last_message_at   TIMESTAMPTZ,
  last_message_preview TEXT,
  last_inbound_at   TIMESTAMPTZ,
  -- WhatsApp 24-hour customer service window; outside it only templates send
  window_expires_at TIMESTAMPTZ,
  ai_auto_reply     BOOLEAN NOT NULL DEFAULT false,
  ai_summary        TEXT,
  ai_intent         TEXT,
  sentiment         TEXT,
  snoozed_until     TIMESTAMPTZ,
  labels            JSONB NOT NULL DEFAULT '[]'::jsonb,
  meta              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel, handle)
);
CREATE INDEX idx_conv_assigned ON ipy_conversation(assigned_to, status);
CREATE INDEX idx_conv_last ON ipy_conversation(last_message_at DESC);
CREATE INDEX idx_conv_record ON ipy_conversation(record_id);

CREATE TABLE ipy_message (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     UUID NOT NULL REFERENCES ipy_conversation(id) ON DELETE CASCADE,
  direction           TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  channel             TEXT NOT NULL,
  type                TEXT NOT NULL DEFAULT 'text',
  body                TEXT,
  media               JSONB,
  template_name       TEXT,
  template_params     JSONB,
  status              TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','sent','delivered','read','failed')),
  error_message       TEXT,
  provider_message_id TEXT,
  provider            TEXT,
  sent_by             UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  is_ai_generated     BOOLEAN NOT NULL DEFAULT false,
  -- link a message back to the workflow/campaign that produced it
  workflow_id         UUID REFERENCES ipy_workflow(id) ON DELETE SET NULL,
  campaign_id         UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  delivered_at        TIMESTAMPTZ,
  read_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_msg_conv ON ipy_message(conversation_id, created_at DESC);
CREATE INDEX idx_msg_provider ON ipy_message(provider_message_id);
CREATE INDEX idx_msg_campaign ON ipy_message(campaign_id);

CREATE TABLE ipy_whatsapp_template (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  language          TEXT NOT NULL DEFAULT 'en',
  category          TEXT NOT NULL DEFAULT 'UTILITY',
  status            TEXT NOT NULL DEFAULT 'LOCAL',
  header_format     TEXT,
  header_text       TEXT,
  body_text         TEXT NOT NULL,
  footer_text       TEXT,
  buttons           JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- maps {{1}} → CRM merge path, e.g. { "1": "contact.first_name" }
  variable_map      JSONB NOT NULL DEFAULT '{}'::jsonb,
  provider_template_id TEXT,
  usage_count       INT NOT NULL DEFAULT 0,
  created_by        UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name, language)
);

CREATE TABLE ipy_email_template (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL UNIQUE,
  subject           TEXT NOT NULL,
  body_html         TEXT NOT NULL,
  body_text         TEXT,
  module_id         UUID REFERENCES ipy_module(id) ON DELETE CASCADE,
  category          TEXT,
  attachments       JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_by        UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ipy_email_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id         UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  direction         TEXT NOT NULL DEFAULT 'outbound',
  from_address      TEXT,
  to_addresses      JSONB NOT NULL DEFAULT '[]'::jsonb,
  cc_addresses      JSONB NOT NULL DEFAULT '[]'::jsonb,
  bcc_addresses     JSONB NOT NULL DEFAULT '[]'::jsonb,
  subject           TEXT,
  body_html         TEXT,
  body_text         TEXT,
  status            TEXT NOT NULL DEFAULT 'queued',
  error_message     TEXT,
  provider_id       TEXT,
  template_id       UUID REFERENCES ipy_email_template(id) ON DELETE SET NULL,
  opened_at         TIMESTAMPTZ,
  clicked_at        TIMESTAMPTZ,
  open_count        INT NOT NULL DEFAULT 0,
  tracking_id       TEXT,
  sent_by           UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  is_ai_generated   BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_email_record ON ipy_email_log(record_id, created_at DESC);
CREATE INDEX idx_email_tracking ON ipy_email_log(tracking_id);

-- ---------------------------------------------------------------------------
-- Telephony
-- ---------------------------------------------------------------------------

CREATE TABLE ipy_call (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  direction         TEXT NOT NULL CHECK (direction IN ('inbound','outbound','missed')),
  from_number       TEXT NOT NULL,
  to_number         TEXT NOT NULL,
  user_id           UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  record_id         UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  record_module     TEXT,
  contact_id        UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'queued',
  duration_seconds  INT NOT NULL DEFAULT 0,
  ring_seconds      INT NOT NULL DEFAULT 0,
  recording_url     TEXT,
  recording_key     TEXT,
  provider          TEXT NOT NULL DEFAULT 'none',
  provider_call_id  TEXT,
  -- IVR / campaign routing
  virtual_number    TEXT,
  ivr_path          JSONB,
  disposition       TEXT,
  notes             TEXT,
  cost              NUMERIC(10,4),
  -- AI enrichment
  transcript        TEXT,
  transcript_segments JSONB,
  ai_summary        TEXT,
  ai_sentiment      TEXT,
  ai_next_actions   JSONB,
  ai_objections     JSONB,
  ai_talk_ratio     NUMERIC(5,2),
  ai_score          INT,
  ai_analysed_at    TIMESTAMPTZ,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at       TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_call_record ON ipy_call(record_id, started_at DESC);
CREATE INDEX idx_call_user ON ipy_call(user_id, started_at DESC);
CREATE INDEX idx_call_provider ON ipy_call(provider_call_id);
CREATE INDEX idx_call_numbers ON ipy_call(from_number, to_number);

-- Virtual/tracking numbers mapped to campaigns or projects for source attribution
CREATE TABLE ipy_virtual_number (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number            TEXT NOT NULL UNIQUE,
  label             TEXT,
  provider          TEXT,
  campaign_id       UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  project_id        UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  lead_source       TEXT,
  route_to_group_id UUID REFERENCES ipy_group(id) ON DELETE SET NULL,
  route_to_user_id  UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  ivr_config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- AI
-- ---------------------------------------------------------------------------

CREATE TABLE ipy_ai_insight (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id         UUID REFERENCES ipy_record(id) ON DELETE CASCADE,
  module_name       TEXT,
  kind              TEXT NOT NULL,
  title             TEXT NOT NULL,
  body              TEXT NOT NULL DEFAULT '',
  data              JSONB NOT NULL DEFAULT '{}'::jsonb,
  score             NUMERIC(6,2),
  confidence        NUMERIC(4,3),
  model             TEXT,
  input_tokens      INT,
  output_tokens     INT,
  user_id           UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  dismissed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_insight_record ON ipy_ai_insight(record_id, kind, created_at DESC);
CREATE INDEX idx_insight_kind ON ipy_ai_insight(kind, created_at DESC);

-- Every AI call is logged: cost control, debugging, and an audit trail of what
-- the assistant was asked and what it answered.
CREATE TABLE ipy_ai_log (
  id                BIGSERIAL PRIMARY KEY,
  feature           TEXT NOT NULL,
  model             TEXT,
  user_id           UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  record_id         UUID,
  prompt_summary    TEXT,
  input_tokens      INT NOT NULL DEFAULT 0,
  output_tokens     INT NOT NULL DEFAULT 0,
  latency_ms        INT,
  success           BOOLEAN NOT NULL DEFAULT true,
  error             TEXT,
  cached            BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ailog_feature ON ipy_ai_log(feature, created_at DESC);
CREATE INDEX idx_ailog_user ON ipy_ai_log(user_id, created_at DESC);

-- Lead-scoring model configuration: admins tune weights without redeploying
CREATE TABLE ipy_scoring_model (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id         UUID NOT NULL REFERENCES ipy_module(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  use_ai            BOOLEAN NOT NULL DEFAULT true,
  -- deterministic rules applied before/alongside the LLM
  rules             JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- grade thresholds: { "A": 80, "B": 60, "C": 40 }
  grade_thresholds  JSONB NOT NULL DEFAULT '{"A":80,"B":60,"C":40}'::jsonb,
  auto_score_on_create BOOLEAN NOT NULL DEFAULT true,
  auto_score_on_activity BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Persisted AI agent conversations ("Ask your CRM")
CREATE TABLE ipy_ai_thread (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES ipy_user(id) ON DELETE CASCADE,
  title             TEXT,
  context_record_id UUID,
  context_module    TEXT,
  messages          JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_aithread_user ON ipy_ai_thread(user_id, updated_at DESC);

-- ---------------------------------------------------------------------------
-- Integrations & lead capture
-- ---------------------------------------------------------------------------

CREATE TABLE ipy_integration (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          TEXT NOT NULL,        -- meta_whatsapp / twilio / exotel / facebook_leads / 99acres ...
  kind              TEXT NOT NULL,        -- messaging / telephony / lead_source / email / storage
  label             TEXT NOT NULL,
  is_active         BOOLEAN NOT NULL DEFAULT false,
  -- non-secret configuration; secrets live in credentials
  config            JSONB NOT NULL DEFAULT '{}'::jsonb,
  credentials       JSONB NOT NULL DEFAULT '{}'::jsonb,
  status            TEXT NOT NULL DEFAULT 'disconnected',
  last_sync_at      TIMESTAMPTZ,
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, label)
);

-- Web forms / landing pages that create leads
CREATE TABLE ipy_webform (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  public_key        TEXT NOT NULL UNIQUE,
  module_id         UUID NOT NULL REFERENCES ipy_module(id) ON DELETE CASCADE,
  -- ordered field definitions rendered by the embeddable widget
  fields            JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- values forced onto every submission (lead_source, campaign, owner)
  defaults          JSONB NOT NULL DEFAULT '{}'::jsonb,
  assign_to_user_id UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  assign_rule_id    UUID REFERENCES ipy_assignment_rule(id) ON DELETE SET NULL,
  redirect_url      TEXT,
  success_message   TEXT,
  captcha_enabled   BOOLEAN NOT NULL DEFAULT true,
  allowed_origins   JSONB NOT NULL DEFAULT '[]'::jsonb,
  notify_user_ids   JSONB NOT NULL DEFAULT '[]'::jsonb,
  auto_respond_template TEXT,
  submission_count  INT NOT NULL DEFAULT 0,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Raw inbound payloads from every lead source; kept for replay + debugging
CREATE TABLE ipy_lead_inbox (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source            TEXT NOT NULL,
  external_id       TEXT,
  raw_payload       JSONB NOT NULL,
  normalized        JSONB,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processed','duplicate','failed','ignored')),
  record_id         UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  error             TEXT,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at      TIMESTAMPTZ
);
CREATE INDEX idx_leadinbox_status ON ipy_lead_inbox(status, received_at);
CREATE UNIQUE INDEX idx_leadinbox_external ON ipy_lead_inbox(source, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE ipy_webhook (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  url               TEXT NOT NULL,
  method            TEXT NOT NULL DEFAULT 'POST',
  headers           JSONB NOT NULL DEFAULT '{}'::jsonb,
  secret            TEXT,
  events            JSONB NOT NULL DEFAULT '[]'::jsonb,
  module_id         UUID REFERENCES ipy_module(id) ON DELETE CASCADE,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  failure_count     INT NOT NULL DEFAULT 0,
  last_status       INT,
  last_called_at    TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ipy_api_key (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  key_prefix        TEXT NOT NULL,
  key_hash          TEXT NOT NULL,
  user_id           UUID REFERENCES ipy_user(id) ON DELETE CASCADE,
  scopes            JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_used_at      TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_apikey_prefix ON ipy_api_key(key_prefix);

-- ---------------------------------------------------------------------------
-- Import / export jobs
-- ---------------------------------------------------------------------------

CREATE TABLE ipy_import_job (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id         UUID NOT NULL REFERENCES ipy_module(id) ON DELETE CASCADE,
  user_id           UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  file_name         TEXT,
  storage_key       TEXT,
  -- csv column → CRM field
  mapping           JSONB NOT NULL DEFAULT '{}'::jsonb,
  duplicate_handling TEXT NOT NULL DEFAULT 'skip'
                    CHECK (duplicate_handling IN ('skip','overwrite','merge','create')),
  status            TEXT NOT NULL DEFAULT 'pending',
  total_rows        INT NOT NULL DEFAULT 0,
  processed_rows    INT NOT NULL DEFAULT 0,
  created_rows      INT NOT NULL DEFAULT 0,
  updated_rows      INT NOT NULL DEFAULT 0,
  skipped_rows      INT NOT NULL DEFAULT 0,
  failed_rows       INT NOT NULL DEFAULT 0,
  errors            JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ
);

-- Sales targets for leaderboards and forecast widgets
CREATE TABLE ipy_target (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID REFERENCES ipy_user(id) ON DELETE CASCADE,
  group_id          UUID REFERENCES ipy_group(id) ON DELETE CASCADE,
  project_id        UUID REFERENCES ipy_record(id) ON DELETE CASCADE,
  period_type       TEXT NOT NULL DEFAULT 'month' CHECK (period_type IN ('month','quarter','year')),
  period_start      DATE NOT NULL,
  period_end        DATE NOT NULL,
  metric            TEXT NOT NULL DEFAULT 'booking_value',
  target_value      NUMERIC(18,2) NOT NULL DEFAULT 0,
  achieved_value    NUMERIC(18,2) NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_target_period ON ipy_target(period_start, period_end);
