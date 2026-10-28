-- Waiting-for-reply alerts for WhatsApp chats (design: docs/designs/whatsapp-unanswered-chat-watch.md).
-- A reply is judged on the database's own clock, never the provider's, so the message gets `received_at` and the
-- conversation gets `last_inbound_seen_at`. Existing rows are backfilled so nothing looks newly unanswered.
-- Ships OFF. To undo: drop the added columns, the index and the three settings rows.
ALTER TABLE ipy_message ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;
UPDATE ipy_message SET received_at = created_at WHERE received_at IS NULL;
ALTER TABLE ipy_message ALTER COLUMN received_at SET DEFAULT now();
ALTER TABLE ipy_message ALTER COLUMN received_at SET NOT NULL;

ALTER TABLE ipy_conversation ADD COLUMN IF NOT EXISTS last_inbound_seen_at TIMESTAMPTZ;
UPDATE ipy_conversation SET last_inbound_seen_at = last_inbound_at WHERE last_inbound_seen_at IS NULL AND last_inbound_at IS NOT NULL;
ALTER TABLE ipy_conversation ADD COLUMN IF NOT EXISTS wait_nudge_1_at TIMESTAMPTZ;
ALTER TABLE ipy_conversation ADD COLUMN IF NOT EXISTS wait_nudge_2_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_conversation_waiting ON ipy_conversation (last_inbound_at)
  WHERE status IN ('open','pending','snoozed');

INSERT INTO ipy_setting (key, value, category, label, description) VALUES
  ('whatsapp.wait_watch.enabled', 'false'::jsonb, 'whatsapp', 'Waiting-for-reply alerts',
   'Tell the person who holds a WhatsApp chat when a customer has waited for a reply. Nothing is ever sent to the customer.'),
  ('whatsapp.wait_watch.first_minutes', '15'::jsonb, 'whatsapp', 'Alert the holder after (working minutes)',
   'Counted only inside Business Hours. 5 to 240.'),
  ('whatsapp.wait_watch.second_minutes', '60'::jsonb, 'whatsapp', 'Alert admins after (working minutes)',
   'Counted only inside Business Hours. Always at least 5 more than the first limit.')
ON CONFLICT (key) DO NOTHING;
