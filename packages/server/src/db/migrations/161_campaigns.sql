-- Sending one approved template to many people, on purpose and once each.
--
-- This feature exists under one rule, and the rule is written in this repo's
-- own history: on 13 and 16 September a *daily* workflow whose condition list
-- had emptied itself queued 40,515 WhatsApp messages — 20,209 people holding
-- two each — and nobody received one only because no provider was connected.
-- Luck, not a safeguard.
--
-- A campaign is deliberately "message many people", so "refuse to match
-- everybody" cannot be the protection. These two tables are:
--
--   * **The audience is frozen.** Approving a campaign writes one row per
--     recipient, here, now. A saved view edited afterwards cannot grow a
--     campaign that is already running, because nothing re-reads the view.
--   * **Once each.** `(campaign_id, record_id)` is unique, so a retry, a
--     double-click or two workers draining the same batch cannot send the same
--     person the same message twice.
--   * **Every refusal is a row you can read**, not a silence: opted out,
--     no number, a blank the template needed. The birthday messages were
--     invisible until somebody counted the queue.
--
-- Deliberately absent: a schedule. A campaign that fires itself at nine in the
-- morning is precisely the shape of the rule that caused all this. A person
-- approves it, with the count in front of them.

CREATE TABLE IF NOT EXISTS ipy_campaign (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  module_name   TEXT NOT NULL,
  -- The approved template it sends. A campaign cannot send free text: outside
  -- WhatsApp's 24-hour window nothing else may go, and a campaign by
  -- definition reaches people who are not in an open conversation.
  template_id   UUID NOT NULL REFERENCES ipy_whatsapp_template(id) ON DELETE RESTRICT,
  -- `{ "view": "<id>" }` or `{ "filter": <FilterGroup> }`. Kept after freezing
  -- for one reason only: so somebody can read later what this campaign *was*
  -- aimed at. It is never re-read to decide who gets a message.
  audience      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT NOT NULL DEFAULT 'draft',
  created_by    UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  approved_by   UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  approved_at   TIMESTAMPTZ,
  -- What the person was shown when they approved. Kept so the number on the
  -- screen and the number that went out can be compared afterwards.
  approved_count INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_campaign_status ON ipy_campaign (status, created_at DESC);

CREATE TABLE IF NOT EXISTS ipy_campaign_recipient (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  UUID NOT NULL REFERENCES ipy_campaign(id) ON DELETE CASCADE,
  record_id    UUID NOT NULL REFERENCES ipy_record(id) ON DELETE CASCADE,
  -- The number as the CRM matched it, written down at freeze time. A record
  -- whose phone is corrected mid-campaign keeps the number the campaign was
  -- approved against; changing it under way is a different message to a
  -- different person.
  handle       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  error        TEXT,
  message_id   UUID REFERENCES ipy_message(id) ON DELETE SET NULL,
  sent_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Once each, enforced by the database rather than by whoever is careful.
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_recipient
  ON ipy_campaign_recipient (campaign_id, record_id);
-- The drain reads exactly this: the next few still waiting.
CREATE INDEX IF NOT EXISTS idx_campaign_recipient_pending
  ON ipy_campaign_recipient (campaign_id, status);
