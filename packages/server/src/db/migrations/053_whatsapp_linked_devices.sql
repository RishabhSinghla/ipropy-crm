-- Linking a rep's own WhatsApp to the CRM, the way WhatsApp Web links a laptop.
--
-- The Meta Cloud API is the sanctioned path and stays exactly as it was. This is
-- the other one: a number that is already on the WhatsApp app, linked as an
-- extra device, so the CRM can send and receive through the number a customer
-- already recognises. No Meta approval, no template approval, no 24-hour
-- window, no per-message fee.
--
-- The cost is that WhatsApp does not permit it and can ban the number, which is
-- why `daily_cap` and the warm-up columns below exist in the schema rather than
-- in somebody's head. A number's survival depends on how it behaves, and
-- behaviour is the one part of this we control.
--
-- A number lives in one world or the other, never both: registering it with the
-- Cloud API removes it from the WhatsApp app. So `handle` is unique across this
-- table and a link is refused for the number configured on `meta_whatsapp`.

CREATE TABLE IF NOT EXISTS ipy_wa_link (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Whose WhatsApp this is. Messages assigned to this user go out from here,
  -- which is the point: the buyer sees the rep they already talk to.
  user_id         UUID NOT NULL REFERENCES ipy_user(id) ON DELETE CASCADE,

  -- E.164, and only known once WhatsApp says who scanned. Null while pending.
  handle          TEXT UNIQUE,
  label           TEXT,

  --   pending    row exists, nobody has scanned the code yet
  --   connected  live, and may send
  --   logged_out the phone removed the linked device, or WhatsApp ended it
  --   disabled   a person switched it off here; the bridge must not reconnect
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'connected', 'logged_out', 'disabled')),

  -- The pairing code the phone camera reads. Written by the bridge, read by the
  -- settings screen, and short-lived on purpose: WhatsApp rotates it about
  -- every twenty seconds, so a stale one shown to a rep simply will not scan.
  qr              TEXT,
  qr_expires_at   TIMESTAMPTZ,

  linked_at       TIMESTAMPTZ,
  -- The bridge stamps this on every poll. Silence means the Mac is asleep, the
  -- bridge is stopped, or the link is dead, and the settings screen has to be
  -- able to tell a rep which.
  last_seen_at    TIMESTAMPTZ,
  last_error      TEXT,

  -- Today's count, with the day it belongs to. Two columns rather than a
  -- separate table because the only question ever asked of it is "may this
  -- number send one more right now", and a stale date answers that by itself.
  sent_today      INTEGER NOT NULL DEFAULT 0 CHECK (sent_today >= 0),
  sent_today_on   DATE,
  -- When this number last put a message out, and how many it has ever sent.
  --
  -- `last_sent_at` is what makes the gap between messages enforceable here
  -- rather than in the bridge. The bridge is a process on a laptop: it gets
  -- restarted, it runs twice by accident, it is edited by whoever is curious.
  -- Anything it remembers about pacing is forgotten on restart, and the first
  -- thing an un-paced bridge does is send the whole backlog in one burst, which
  -- is exactly the pattern that gets a number banned. So the CRM hands out one
  -- message at a time and refuses the next until the gap has passed.
  last_sent_at    TIMESTAMPTZ,
  sent_total      INTEGER NOT NULL DEFAULT 0 CHECK (sent_total >= 0),
  -- An explicit override. Null means use the warm-up schedule computed from
  -- `linked_at`, which is what almost every link should do.
  daily_cap       INTEGER CHECK (daily_cap IS NULL OR daily_cap > 0),

  -- Whether this number also sends the messages nobody owns.
  --
  -- Not a detail. A queued message takes its assignee from the lead's owner, and
  -- a lead that arrived from a website form before the assignment rules ran has
  -- no owner at all: 61 of the 62 messages waiting in this database are
  -- unassigned. Without somewhere for those to go, linking a number would drain
  -- one message and leave the rest sitting exactly where they are, which reads
  -- as the feature not working.
  takes_unassigned BOOLEAN NOT NULL DEFAULT false,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One live link per person. A rep with two phones is a real thing, but it is
-- not this: two links for one user would race for the same queued messages and
-- the buyer would get the message twice from two different numbers.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_link_user_live
  ON ipy_wa_link(user_id)
  WHERE status IN ('pending', 'connected');

CREATE INDEX IF NOT EXISTS idx_wa_link_status
  ON ipy_wa_link(status, last_seen_at DESC);

-- Exactly one number may claim the unowned messages. Two would both claim the
-- same row, and the buyer would hear from two different people about one thing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_link_unassigned
  ON ipy_wa_link((takes_unassigned))
  WHERE takes_unassigned AND status IN ('pending', 'connected');

-- Which linked number sent a queued message, when one did.
--
-- The queue was built for a human with a thumb, and that path is unchanged: a
-- row belonging to somebody with no linked number still waits in Outreach for
-- one tap. This column is what distinguishes the two afterwards, which matters
-- because only one of them can be believed about delivery.
ALTER TABLE ipy_device_send
  ADD COLUMN IF NOT EXISTS wa_link_id UUID REFERENCES ipy_wa_link(id) ON DELETE SET NULL;

-- Claimed, so two bridge polls cannot both take the same row, and so a bridge
-- that dies mid-send leaves evidence rather than a row that looks untouched.
ALTER TABLE ipy_device_send
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

ALTER TABLE ipy_device_send
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;

-- Two states the queue never needed while a human was the only sender.
--
--   claimed  a linked phone has been handed this and is sending it. Distinct
--            from 'opened', which means a person tapped the link and may or may
--            not have pressed send.
--   failed   the phone tried and could not. Not 'skipped': nobody decided to
--            skip it, and the two want different answers from whoever looks.
ALTER TABLE ipy_device_send DROP CONSTRAINT IF EXISTS ipy_device_send_status_check;
ALTER TABLE ipy_device_send ADD CONSTRAINT ipy_device_send_status_check
  CHECK (status IN ('pending', 'opened', 'claimed', 'sent', 'skipped', 'failed'));

-- The queue reader asks one question over and over: what is waiting, for whom,
-- oldest first.
CREATE INDEX IF NOT EXISTS idx_device_send_claimable
  ON ipy_device_send(status, assigned_to, created_at)
  WHERE status = 'pending';

-- The provider slot, so it appears in Admin → Integrations beside Meta's.
-- Inactive until somebody turns it on, like every other integration.
INSERT INTO ipy_integration (provider, kind, label)
VALUES ('whatsapp_linked', 'messaging', 'WhatsApp via linked phone')
ON CONFLICT (provider, label) DO NOTHING;
