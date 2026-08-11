-- Sending one property to one person.
--
-- The original complaint, in his words: "then later I have to send it to some
-- party and everything is so cluttered". Capture solved getting the photos in.
-- This is getting them back out to a buyer, which until now had no path at all.
--
-- The website is not that path and cannot be. `/api/public/properties` is a
-- catalogue: it shows units whose status is 'Available' and that are published
-- to the web. A floor photographed this morning is neither — it is a draft with
-- forty photos on it, and it is exactly the one somebody wants to send. Waiting
-- for it to be publishable before it can be shown to a buyer is backwards.
--
-- So a share link is its own thing: one property, one unguessable URL, made on
-- purpose by somebody who has permission to see that record, revocable, and
-- independent of whether the unit is ready for the public website.
--
-- The label is the quietly useful part. A dealer sends the same floor to six
-- people; naming each link after who it went to turns an anonymous view counter
-- into "the one I sent Rajesh has been opened four times" — which is a buying
-- signal, and it needs no tracking beyond counting requests.

CREATE TABLE IF NOT EXISTS ipy_share_link (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id    UUID NOT NULL REFERENCES ipy_record(id) ON DELETE CASCADE,

  -- The secret in the URL. Unguessable rather than sequential: this is the only
  -- thing standing between a link and the open internet, so it is 16 random
  -- bytes, not a slug somebody could walk.
  token        TEXT NOT NULL UNIQUE,

  -- Who it was sent to, as free text. Never shown on the public page — it is
  -- the sender's own note to themselves, and a buyer opening a link should not
  -- be told what the dealer wrote about them.
  label        TEXT,

  created_by   UUID NOT NULL REFERENCES ipy_user(id) ON DELETE CASCADE,

  -- Null means it does not expire. Deliberate: a dealer who sends a link on
  -- Monday and gets a call about it in March should not have to explain that
  -- the CRM quietly turned it off.
  expires_at   TIMESTAMPTZ,
  -- Set instead of deleting the row, so the view history survives revocation.
  revoked_at   TIMESTAMPTZ,

  view_count   INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TIMESTAMPTZ,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The public read: resolve a token on every page load and every image request.
-- The unique constraint on token already provides this index, but the partial
-- one keeps the live set small as revoked links accumulate.
CREATE INDEX IF NOT EXISTS idx_share_link_live
  ON ipy_share_link(token)
  WHERE revoked_at IS NULL;

-- The CRM read: "who have I sent this property to?"
CREATE INDEX IF NOT EXISTS idx_share_link_record
  ON ipy_share_link(record_id, created_at DESC);
