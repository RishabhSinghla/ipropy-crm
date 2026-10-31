-- The two WhatsApp screens (plain chat on OpenWA, official API on WhatsMarketing) must never share a thread.
-- Until now one conversation per phone number held messages from both, so the same lead showed in both screens.
-- Each business conversation now has a `lane`: 'chat' (provider whatsapp_openwa) or 'api' (any other provider).
-- Existing mixed conversations are split by the PROVIDER each message was actually written with. Nothing is deleted;
-- a message with no provider stays where it is. Safe to run twice: after the first run no conversation is mixed.
ALTER TABLE ipy_conversation ADD COLUMN IF NOT EXISTS lane TEXT;
ALTER TABLE ipy_conversation DROP CONSTRAINT IF EXISTS ipy_conversation_lane_check;
ALTER TABLE ipy_conversation ADD CONSTRAINT ipy_conversation_lane_check CHECK (lane IS NULL OR lane IN ('chat', 'api'));

-- Lane from the conversation's messages: the lane holding most of them (ties go to the newest message).
UPDATE ipy_conversation c SET lane = pick.lane
  FROM (
    SELECT DISTINCT ON (m.conversation_id) m.conversation_id,
           CASE WHEN m.provider = 'whatsapp_openwa' THEN 'chat' ELSE 'api' END AS lane
      FROM ipy_message m
     WHERE m.provider IS NOT NULL
     GROUP BY m.conversation_id, CASE WHEN m.provider = 'whatsapp_openwa' THEN 'chat' ELSE 'api' END
     ORDER BY m.conversation_id, count(*) DESC, max(m.created_at) DESC
  ) pick
 WHERE c.id = pick.conversation_id AND c.channel = 'whatsapp' AND c.wa_account_id IS NULL AND c.lane IS NULL;

-- One business conversation per number per lane. The old rule (one per number, any channel) stays for every other
-- channel and for WhatsApp rows with no lane yet (no messages): those keep a NULL lane and are in neither screen.
DROP INDEX IF EXISTS idx_conversation_channel_handle;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_channel_handle
  ON ipy_conversation (channel, handle) WHERE wa_account_id IS NULL AND lane IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_channel_handle_lane
  ON ipy_conversation (channel, handle, lane) WHERE wa_account_id IS NULL AND lane IS NOT NULL;

-- Split every conversation that still holds the other lane's messages into a second conversation.
DO $$
DECLARE
  conv RECORD;
  other TEXT;
  new_id UUID;
  moved INT;
  total_moved INT := 0;
  total_convs INT := 0;
BEGIN
  FOR conv IN
    SELECT id, lane FROM ipy_conversation
     WHERE channel = 'whatsapp' AND wa_account_id IS NULL AND lane IS NOT NULL
       AND EXISTS (SELECT 1 FROM ipy_message m WHERE m.conversation_id = ipy_conversation.id AND m.provider IS NOT NULL
                    AND (CASE WHEN m.provider = 'whatsapp_openwa' THEN 'chat' ELSE 'api' END) <> ipy_conversation.lane)
  LOOP
    other := CASE WHEN conv.lane = 'chat' THEN 'api' ELSE 'chat' END;
    INSERT INTO ipy_conversation (channel, handle, contact_name, record_id, record_module, assigned_to, wa_id, status, lane)
      SELECT channel, handle, contact_name, record_id, record_module, assigned_to, wa_id, status, other
        FROM ipy_conversation WHERE id = conv.id
      RETURNING id INTO new_id;
    UPDATE ipy_message m SET conversation_id = new_id
     WHERE m.conversation_id = conv.id AND m.provider IS NOT NULL
       AND (CASE WHEN m.provider = 'whatsapp_openwa' THEN 'chat' ELSE 'api' END) = other;
    GET DIAGNOSTICS moved = ROW_COUNT;
    total_moved := total_moved + moved;
    total_convs := total_convs + 1;
    -- Rebuild each half's summary from its own messages. Unread stays with the half that holds the newest inbound one.
    UPDATE ipy_conversation c SET
      last_message_at = s.last_at,
      last_message_preview = s.preview,
      last_inbound_at = s.last_in,
      window_expires_at = CASE WHEN s.last_in IS NULL THEN NULL ELSE s.last_in + interval '24 hours' END,
      last_inbound_seen_at = s.last_in,
      wait_nudge_1_at = NULL, wait_nudge_2_at = NULL,
      unread_count = CASE WHEN s.last_in IS NOT NULL AND s.last_in >= COALESCE(o.last_in, '-infinity'::timestamptz)
                          THEN c.unread_count ELSE 0 END
      FROM (SELECT id FROM ipy_conversation WHERE id IN (conv.id, new_id)) t
      CROSS JOIN LATERAL (
        SELECT (SELECT max(created_at) FROM ipy_message WHERE conversation_id = t.id) AS last_at,
               (SELECT left(coalesce(body, ''), 200) FROM ipy_message WHERE conversation_id = t.id ORDER BY created_at DESC LIMIT 1) AS preview,
               (SELECT max(created_at) FROM ipy_message WHERE conversation_id = t.id AND direction = 'inbound') AS last_in
      ) s
      CROSS JOIN LATERAL (
        SELECT (SELECT max(created_at) FROM ipy_message WHERE conversation_id = (CASE WHEN t.id = conv.id THEN new_id ELSE conv.id END) AND direction = 'inbound') AS last_in
      ) o
     WHERE c.id = t.id;
  END LOOP;
  RAISE NOTICE 'WhatsApp lanes: split % conversation(s), moved % message(s)', total_convs, total_moved;
END $$;

