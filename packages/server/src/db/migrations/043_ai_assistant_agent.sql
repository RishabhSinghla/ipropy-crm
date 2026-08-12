-- Ask iPropy is a real workspace assistant, not a stateless prompt box.
-- Memories are deliberately explicit ("remember that ...") and user-owned;
-- we never silently turn every chat sentence into permanent profile data.
CREATE TABLE ipy_ai_memory (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES ipy_user(id) ON DELETE CASCADE,
  fact              TEXT NOT NULL CHECK (length(fact) BETWEEN 1 AND 500),
  normalized_fact   TEXT NOT NULL,
  source_thread_id  UUID REFERENCES ipy_ai_thread(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, normalized_fact)
);
CREATE INDEX idx_ai_memory_user ON ipy_ai_memory(user_id, updated_at DESC);

-- Mutating CRM work is proposed first and executed only after a separate,
-- authenticated confirmation. The stored, validated payload is what executes;
-- the model is never called again during confirmation.
CREATE TABLE ipy_ai_action (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES ipy_user(id) ON DELETE CASCADE,
  thread_id         UUID NOT NULL REFERENCES ipy_ai_thread(id) ON DELETE CASCADE,
  action_type       TEXT NOT NULL CHECK (action_type IN ('update_record')),
  module_name       TEXT NOT NULL,
  record_id         UUID NOT NULL REFERENCES ipy_record(id) ON DELETE CASCADE,
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  preview           TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','confirmed','cancelled','expired')),
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 minutes'),
  confirmed_at      TIMESTAMPTZ,
  cancelled_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_action_user_pending
  ON ipy_ai_action(user_id, created_at DESC) WHERE status = 'pending';
