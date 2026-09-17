-- One WhatsApp account per agent, linked by that agent, sending as that agent.
--
-- This is the third attempt. The first (migration 060) and the second
-- (migration 149, removed 2026-09-17) both died on the same thing: pointed at a
-- real handset they imported the rep's whole phone, which is a person's private
-- life in a business database. The schema now makes that a decision the code
-- has to take deliberately rather than a default it falls into:
--
--   * `user_id` is NOT NULL and unique. An account belongs to exactly one agent,
--     so "whose WhatsApp sent this" is never a guess, and Sheetal's session can
--     never be picked up to send Rahul's message.
--   * `history_scope` records what the agent agreed to sync, and its only
--     permitted value today is 'known_contacts' — conversations whose number is
--     already a lead in this CRM. It is a column rather than a constant so
--     widening it later is a migration somebody has to write and defend.
--
-- Nothing here drops or rewrites an existing row. The conversations and messages
-- kept back from the removal stay exactly as they are.
CREATE TABLE IF NOT EXISTS ipy_wa_account (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES ipy_user(id) ON DELETE CASCADE,
  label                 TEXT NOT NULL,
  phone_number          TEXT,
  display_name          TEXT,
  auth_state_encrypted  TEXT,
  status                TEXT NOT NULL DEFAULT 'disconnected'
                        CHECK (status IN ('disconnected','connecting','qr','pairing','connected','error')),
  -- What this account is allowed to bring into the CRM. One value for now, by design.
  history_scope         TEXT NOT NULL DEFAULT 'known_contacts'
                        CHECK (history_scope IN ('known_contacts')),
  -- An admin switch that does not destroy anything: a deactivated agent stops
  -- sending, and every message they already sent stays on the contact.
  is_enabled            BOOLEAN NOT NULL DEFAULT true,
  last_connected_at     TIMESTAMPTZ,
  last_seen_at          TIMESTAMPTZ,
  last_synced_at        TIMESTAMPTZ,
  last_error            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One per agent, and one agent per number. Both halves matter: the first stops a
-- rep linking two phones the CRM would have to choose between, the second stops
-- two reps claiming the same number and the audit trail becoming a coin toss.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_account_user ON ipy_wa_account(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_account_phone
  ON ipy_wa_account(phone_number) WHERE phone_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wa_account_status ON ipy_wa_account(status, updated_at DESC);

-- What happened to a link, for the admin page and for working out why a session
-- died. Never message bodies — this is connection health, not content.
CREATE TABLE IF NOT EXISTS ipy_wa_event (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES ipy_wa_account(id) ON DELETE CASCADE,
  level       TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info','warn','error')),
  event       TEXT NOT NULL,
  detail      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_event_account ON ipy_wa_event(account_id, created_at DESC);

-- Which agent's account carried a conversation and each message on it.
ALTER TABLE ipy_conversation ADD COLUMN IF NOT EXISTS wa_account_id UUID
  REFERENCES ipy_wa_account(id) ON DELETE SET NULL;
ALTER TABLE ipy_message ADD COLUMN IF NOT EXISTS wa_account_id UUID
  REFERENCES ipy_wa_account(id) ON DELETE SET NULL;

-- ON DELETE SET NULL on both, deliberately. An agent leaving the company must
-- not take the conversation with them: the account row can go, the messages stay
-- on the contact, and the timeline keeps saying what was said and when.
CREATE INDEX IF NOT EXISTS idx_message_wa_account
  ON ipy_message(wa_account_id, created_at DESC) WHERE wa_account_id IS NOT NULL;

-- The same message must never land twice, however it arrives: a reconnect
-- replaying a batch, a retry, a restart mid-sync. The provider's own id scoped
-- to the account is the natural key, and a partial index keeps every historical
-- row — which has no account — out of the constraint.
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_provider_id_per_account
  ON ipy_message(wa_account_id, provider_message_id)
  WHERE wa_account_id IS NOT NULL AND provider_message_id IS NOT NULL;
