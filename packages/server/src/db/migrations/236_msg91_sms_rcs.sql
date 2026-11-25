-- SMS and RCS through MSG91, sent to many people on purpose and once each.
--
-- This is the same shape as WhatsApp campaigns (migration 161) and for the same
-- reason: a campaign is deliberately "message many people", so the protection is
-- not a refusal to match everybody. It is that
--   * the audience is frozen when a person approves a number they were shown,
--   * each person appears once (unique index, not carefulness), and
--   * every refusal is a row somebody can read.
--
-- Nothing here sends anything. The MSG91 card is created switched OFF with no
-- key, so a deploy of this migration cannot cost a paisa.

INSERT INTO ipy_integration (provider, kind, label)
VALUES ('msg91', 'messaging', 'MSG91 — SMS and RCS')
ON CONFLICT (provider, label) DO NOTHING;

CREATE TABLE IF NOT EXISTS ipy_bulk_message (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  channel       TEXT NOT NULL CHECK (channel IN ('sms', 'rcs')),
  module_name   TEXT NOT NULL,
  -- `{ "view": "<id>" }` or `{ "everyone": true }`. Kept only so somebody can
  -- read later what this was aimed at; never re-read to decide who gets it.
  audience      JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- SMS: the DLT template id MSG91 holds, and what fills each of its blanks
  -- (`{ "name": "{{first_name}}" }`). RCS: the text itself, with {{merge}} tokens.
  template_id   TEXT,
  variables     JSONB NOT NULL DEFAULT '{}'::jsonb,
  body          TEXT,
  status        TEXT NOT NULL DEFAULT 'draft',
  created_by    UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  approved_by   UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  approved_at   TIMESTAMPTZ,
  approved_count INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bulk_message_status ON ipy_bulk_message (status, created_at DESC);

CREATE TABLE IF NOT EXISTS ipy_bulk_message_recipient (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bulk_id      UUID NOT NULL REFERENCES ipy_bulk_message(id) ON DELETE CASCADE,
  record_id    UUID NOT NULL REFERENCES ipy_record(id) ON DELETE CASCADE,
  -- E.164 as matched at freeze time (+919876543210).
  handle       TEXT NOT NULL,
  -- What this person will be sent, filled in at freeze time: the blanks for an
  -- SMS (`{ "name": "Anita" }`) or `{ "text": "…" }` for RCS. Frozen with the
  -- audience, so editing the record afterwards cannot change an approved message.
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status       TEXT NOT NULL DEFAULT 'pending',
  error        TEXT,
  provider_ref TEXT,
  sent_at      TIMESTAMPTZ,
  -- When a batch took this person. A batch stuck 'sending' for 15 minutes was a crash.
  claimed_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bulk_id, record_id)
);

CREATE INDEX IF NOT EXISTS idx_bulk_recipient_pending
  ON ipy_bulk_message_recipient (bulk_id, created_at) WHERE status = 'pending';
