-- How warm the person sounded, recorded on the call rather than on the record.
--
-- The call console offers Hot / Warm / Cold beside the notes. The obvious home
-- for that looks like `leads.rating`, and it is the wrong one: that field is
-- read-only on purpose because the scorer owns it. When it was editable an
-- edit was accepted, written into the audit trail, and then overwritten by the
-- scorer moments later -- the rep saw Hot, the database kept Warm, and nothing
-- said so.
--
-- A rep's own read of one conversation is a fact about that conversation. It
-- belongs next to the outcome and the notes, where nothing overwrites it.
ALTER TABLE ipy_call ADD COLUMN IF NOT EXISTS intent TEXT;

DO $$
BEGIN
  ALTER TABLE ipy_call ADD CONSTRAINT ipy_call_intent_check
    CHECK (intent IS NULL OR intent IN ('hot','warm','cold'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
