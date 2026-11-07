-- The slow promotional drip on the linked WhatsApp numbers (OpenWA).
--
-- Nothing here sends anything by itself: a drip is created as a draft, and only an
-- admin pressing Start (after being shown how many people it is) makes it run.
-- It sends one person at a time, a minute or two apart, a few dozen a day per number.
--
-- Three tables:
--   ipy_wa_drip        the queue itself: who, what words, which numbers, how fast, its state
--   ipy_wa_drip_item   one row per person, frozen when Start is pressed; the unique indexes
--                      are what guarantee "once each", not carefulness
--   ipy_wa_drip_event  the audit trail: who started/paused/stopped it, and why it paused itself

CREATE TABLE IF NOT EXISTS ipy_wa_drip (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  module_name    TEXT NOT NULL DEFAULT 'leads',
  -- `{ "view": "<saved filter id>" }`. Kept to read later; never re-read to decide who gets it.
  audience       JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The approved wordings (1 to 6). Each may hold {name}; every send also gets the opt-out line.
  variants       JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Which linked numbers carry it. A selected number that goes down pauses the whole queue.
  number_ids     UUID[] NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'running', 'paused', 'stopped', 'done')),
  -- Why it is paused, in words an admin can read. Empty when running.
  pause_reason   TEXT,
  paused_by_system BOOLEAN NOT NULL DEFAULT false,
  -- Speed. Per number per day: start low, add `cap_step` every `cap_every_days` days the drip really sent,
  -- never above `cap_max` (and the code has its own hard ceiling, far below the 60 a day per user).
  cap_start      INTEGER NOT NULL DEFAULT 20,
  cap_step       INTEGER NOT NULL DEFAULT 5,
  cap_every_days INTEGER NOT NULL DEFAULT 3,
  cap_max        INTEGER NOT NULL DEFAULT 40,
  gap_min_seconds INTEGER NOT NULL DEFAULT 60,
  gap_max_seconds INTEGER NOT NULL DEFAULT 120,
  -- Only inside these hours of the organisation's day.
  window_from    INTEGER NOT NULL DEFAULT 10,
  window_to      INTEGER NOT NULL DEFAULT 18,
  -- Stop by itself after this many sends (for "send 5 first"). Null = until the list is done.
  max_total      INTEGER,
  approved_count INTEGER,
  next_send_at   TIMESTAMPTZ,
  created_by     UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  -- The admin the messages are recorded as sent by (the one who pressed Start / Resume).
  started_by     UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only one drip runs at a time: the gap between sends is shared, so two would double the speed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_drip_one_running ON ipy_wa_drip ((true)) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS ipy_wa_drip_item (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drip_id     UUID NOT NULL REFERENCES ipy_wa_drip(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  record_id   UUID NOT NULL REFERENCES ipy_record(id) ON DELETE CASCADE,
  label       TEXT,
  first_name  TEXT,
  -- Last ten digits: the same key every other send and opt-out check uses.
  handle      TEXT NOT NULL,
  -- pending | sending | sent | skipped | failed
  status      TEXT NOT NULL DEFAULT 'pending',
  skip_reason TEXT,
  error       TEXT,
  variant     INTEGER,
  number_id   UUID REFERENCES ipy_wa_number(id) ON DELETE SET NULL,
  message_id  UUID REFERENCES ipy_message(id) ON DELETE SET NULL,
  -- When the send was tried (sent or failed), and when it went out.
  attempted_at TIMESTAMPTZ,
  sent_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Once each, in this drip.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_drip_item_once ON ipy_wa_drip_item (drip_id, record_id);
-- And once each across every drip: a number the queue has messaged (or is messaging this second) is never messaged again.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_drip_item_handle_once ON ipy_wa_drip_item (handle) WHERE status IN ('sending', 'sent');
CREATE INDEX IF NOT EXISTS idx_wa_drip_item_next ON ipy_wa_drip_item (drip_id, status, seq);
CREATE INDEX IF NOT EXISTS idx_wa_drip_item_sent ON ipy_wa_drip_item (number_id, sent_at) WHERE status = 'sent';

CREATE TABLE IF NOT EXISTS ipy_wa_drip_event (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drip_id    UUID NOT NULL REFERENCES ipy_wa_drip(id) ON DELETE CASCADE,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- created | started | paused | auto_paused | resumed | stopped | finished | test_sent | settings
  kind       TEXT NOT NULL,
  user_id    UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  number_id  UUID REFERENCES ipy_wa_number(id) ON DELETE SET NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_wa_drip_event_drip ON ipy_wa_drip_event (drip_id, at DESC);
