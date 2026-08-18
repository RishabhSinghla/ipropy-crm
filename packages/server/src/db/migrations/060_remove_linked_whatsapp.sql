-- The linked-phone WhatsApp, removed at the owner's request.
--
-- It worked, and that was the problem: pointed at a real phone it pulled in 821
-- chats, which is a person's whole private life sitting in a business database.
-- The scoping added in 056 hid those from colleagues, but hiding them is not the
-- same as not holding them, and it is his phone.
--
-- Everything the feature added goes: the sessions table, the two columns on the
-- send queue, the per-conversation privacy flag that only existed to contain the
-- imported chats, and the imported chats themselves.
--
-- What stays, deliberately, because it predates this and is still wanted: the
-- Meta Cloud API path, the Inbox, and the wa.me one-tap hand-off that writes a
-- message for a person to send.

-- The conversations and messages that came off his phone. A chat with a CRM
-- lead is business and stays; everything else was only ever here because the
-- import kept it.
DELETE FROM ipy_message
 WHERE conversation_id IN (
   SELECT id FROM ipy_conversation
    WHERE channel = 'whatsapp' AND record_id IS NULL AND private_to_user_id IS NOT NULL
 );
DELETE FROM ipy_conversation
 WHERE channel = 'whatsapp' AND record_id IS NULL AND private_to_user_id IS NOT NULL;

-- Queue rows that only the bridge could have drained.
DELETE FROM ipy_device_send WHERE priority = 'immediate' AND status IN ('pending', 'claimed');

ALTER TABLE ipy_conversation DROP COLUMN IF EXISTS private_to_user_id;
ALTER TABLE ipy_device_send  DROP COLUMN IF EXISTS priority;
ALTER TABLE ipy_device_send  DROP COLUMN IF EXISTS message_id;
DROP INDEX IF EXISTS idx_conversation_private;
DROP INDEX IF EXISTS idx_device_send_claimable;
CREATE INDEX IF NOT EXISTS idx_device_send_claimable
  ON ipy_device_send (status, assigned_to, created_at) WHERE status = 'pending';

-- wa_link_id points at the sessions table, so it has to go first: Postgres
-- refuses to drop a table another constraint depends on, and CASCADE here would
-- silently take whatever else it found with it.
ALTER TABLE ipy_device_send DROP COLUMN IF EXISTS wa_link_id;
ALTER TABLE ipy_device_send DROP COLUMN IF EXISTS claimed_at;
DROP TABLE IF EXISTS ipy_wa_link;
DELETE FROM ipy_integration WHERE provider = 'whatsapp_linked';
