-- A chat with somebody who is not a customer belongs to one person.
--
-- Until tonight only chats matching a CRM lead were imported, so every
-- conversation in the database was business by definition and the existing
-- scoping — your own threads plus anything unassigned — was right.
--
-- Then the filter came off, because matching against three leads emptied an
-- 821-chat phone. Now a rep's family, their doctor and their landlord are all
-- rows in ipy_conversation with no record and no assignee, which the list
-- treats as "unassigned" and therefore shows to everyone. That is a rep's
-- private life on a colleague's screen, and it is worse for the owner than for
-- anyone: he linked first and has the most in there.
--
-- So a conversation carries who it is private to. Set when it is created from a
-- linked phone and resolves to no CRM record; NULL for anything that is a real
-- business thread. Everyone is filtered by it, admins included — an admin
-- outranks a rep on CRM data, not on whether they may read that rep's
-- conversation with their mother.
ALTER TABLE ipy_conversation
  ADD COLUMN IF NOT EXISTS private_to_user_id uuid REFERENCES ipy_user(id) ON DELETE SET NULL;

-- The list filters on this on every read, alongside channel and status.
CREATE INDEX IF NOT EXISTS idx_conversation_private
  ON ipy_conversation (private_to_user_id)
  WHERE private_to_user_id IS NOT NULL;

-- Anything already imported with no record came off a linked phone during
-- tonight's sync and has never been anything but private. There is exactly one
-- linked number, so the owner is unambiguous; where it is not, the row stays
-- visible rather than being assigned to the wrong person.
UPDATE ipy_conversation c
   SET private_to_user_id = (
     SELECT l.user_id FROM ipy_wa_link l
      WHERE l.status IN ('connected', 'logged_out')
      LIMIT 1
   )
 WHERE c.record_id IS NULL
   AND c.channel = 'whatsapp'
   AND c.private_to_user_id IS NULL
   AND (SELECT count(*) FROM ipy_wa_link WHERE status IN ('connected', 'logged_out')) = 1;
