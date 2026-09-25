-- Permanently delete the WhatsApp messages the removed phone-sync route copied
-- off reps' own handsets. The owner asked for this on 25 September 2026.
--
-- They were reps' personal chats, never the business number, and never in
-- WhatsMarketing's inbox: 1,734 rows on production (2 Aug 2025 – 18 Sep 2026)
-- against 50 from the business number. The screens had already stopped showing
-- them; this removes them. A production backup was taken just before this ran.
--
-- A phone-sync thread is one with a wa_account_id. The business number's
-- threads never have one, so nothing sent or received on it is touched.

-- 1. Their copies in the search index, so the text does not outlive the message.
DELETE FROM ipy_embedding e
 USING ipy_message m
 JOIN ipy_conversation c ON c.id = m.conversation_id
 WHERE e.kind = 'message'
   AND e.source_id = m.id::text
   AND c.wa_account_id IS NOT NULL;

-- 2. Anything that points at one of those messages lets go of it first.
UPDATE ipy_broadcast_recipient SET message_id = NULL
 WHERE message_id IN (
   SELECT m.id FROM ipy_message m
     JOIN ipy_conversation c ON c.id = m.conversation_id
    WHERE c.wa_account_id IS NOT NULL);

UPDATE ipy_campaign_recipient SET message_id = NULL
 WHERE message_id IN (
   SELECT m.id FROM ipy_message m
     JOIN ipy_conversation c ON c.id = m.conversation_id
    WHERE c.wa_account_id IS NOT NULL);

-- 3. The threads. Their messages go with them (ON DELETE CASCADE).
DELETE FROM ipy_conversation WHERE wa_account_id IS NOT NULL;
