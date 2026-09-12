-- A matching somebody agreed, and a link to send it.
--
-- The engine re-scores on every change, which is what you want from a live
-- list and exactly what you do not want once a rep has been through it. They
-- take three units out, send the other six to a customer, and the next time
-- anybody reprices anything the list they agreed quietly becomes a different
-- list — with no record that it ever said something else.
--
-- So a matching can be pinned. `ipy_match_snapshot` holds the rows as they
-- stood, in the order they stood in, with who pinned them and when. Reverting
-- deletes the row and the engine's answer comes back.
--
-- One per record per direction: a lead's saved inventory list and a unit's
-- saved buyer list are different questions about different records, and the
-- primary key says so.

CREATE TABLE IF NOT EXISTS ipy_match_snapshot (
  record_id  uuid NOT NULL REFERENCES ipy_record(id) ON DELETE CASCADE,
  module     text NOT NULL,
  -- [{ targetId, score, matchedFields }] in the order the rep left them.
  entries    jsonb NOT NULL DEFAULT '[]',
  -- The match filters that were switched on, so reopening shows the same list
  -- rather than the saved rows under a different set of toggles.
  filters    jsonb NOT NULL DEFAULT '[]',
  saved_by   uuid REFERENCES ipy_user(id) ON DELETE SET NULL,
  saved_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (record_id, module)
);

-- A share link that carries a set of records, not one.
--
-- `ipy_share_link` was built to send one property to one buyer, so it is keyed
-- by the record it shows. Sharing a matching means sending six of them, and
-- the honest way to say that is a payload on the link rather than six links or
-- a second table that would then need its own token, expiry and revocation —
-- all three of which this table already has and already gets right.
--
-- `kind` defaults to 'record' so every link already issued keeps working and
-- keeps meaning what it meant.
ALTER TABLE ipy_share_link ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'record';
ALTER TABLE ipy_share_link ADD COLUMN IF NOT EXISTS payload jsonb;

-- A link is one kind or the other, and a 'matches' link is nothing without the
-- records it names. Written as a CHECK rather than left to the route, because
-- a link that resolves to an empty page is indistinguishable to the recipient
-- from one that was revoked.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ipy_share_link_kind_payload'
  ) THEN
    ALTER TABLE ipy_share_link ADD CONSTRAINT ipy_share_link_kind_payload
      CHECK (kind = 'record' OR (kind = 'matches' AND payload IS NOT NULL));
  END IF;
END $$;
