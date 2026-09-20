-- The number WhatsApp itself uses, kept beside the number the CRM matches on.
--
-- `ipy_conversation.handle` is the last ten digits, deliberately: that is what
-- matches a contact whether their mobile is stored as 9891222206, +919891222206
-- or 0 9891 222206. It is a **matching key**, and it was also being handed to
-- the provider as a destination.
--
-- WhatsApp cannot dial ten digits. It read `9891222206` as a different person
-- from the `919891222206` who had just written in, found no open session for
-- them, and refused with "Sending message outside 24 hour window is not
-- allowed" -- which reads exactly like a window bug and is not one. Every
-- free-text reply on this CRM has failed that way since the day it was built.
--
-- So the dialable number is stored separately, taken from WhatsApp's own
-- `wa_id` on the way in, which is authoritative in a way a stored phone field
-- never is.
ALTER TABLE ipy_conversation ADD COLUMN IF NOT EXISTS wa_id text;

COMMENT ON COLUMN ipy_conversation.wa_id IS
  'Full international number as WhatsApp reports it (no +). Use this to send; use handle to match.';
