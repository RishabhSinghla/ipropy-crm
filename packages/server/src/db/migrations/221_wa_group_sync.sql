-- The WhatsApp groups the company's linked number (OpenWA) is a member of, and which of them the dealer-groups
-- feed may read. A group is OFF until an admin switches it on: the number may sit in family or personal groups
-- too, and nothing from those may be kept. `name` joins to ipy_market_group.name once it is on.
-- Additive. To undo: DROP TABLE ipy_wa_group;
CREATE TABLE IF NOT EXISTS ipy_wa_group (
  id               TEXT PRIMARY KEY,             -- WhatsApp's id, 1203…@g.us
  name             TEXT NOT NULL DEFAULT '',
  enabled          BOOLEAN NOT NULL DEFAULT false,
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at  TIMESTAMPTZ,
  messages_seen    INTEGER NOT NULL DEFAULT 0,   -- written messages read from this group, live
  history_state    TEXT NOT NULL DEFAULT 'none', -- none | running | done | failed
  history_at       TIMESTAMPTZ,
  history_note     TEXT
);
