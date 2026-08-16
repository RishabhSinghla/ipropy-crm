-- Let a reply typed in the Inbox go out through a linked phone, and go now.
--
-- Two columns on the queue, because the queue was only ever fed by automation:
--
-- `priority` separates a person typing an answer from a workflow sending a
-- follow-up. The 40-to-80-second gap, the daily cap and the 08:00-21:00 window
-- exist because unsolicited automated traffic is what gets a WhatsApp number
-- removed. A human answering a customer who just messaged them is the most
-- ordinary use of WhatsApp there is, and making that person wait a minute and
-- a half turns a chat window into something nobody will use. So 'immediate'
-- skips the pacing; 'paced' keeps every limit exactly as it was.
--
-- `message_id` ties a queued send back to the message row the Inbox already
-- drew, so the bubble goes from a clock to a tick instead of a second copy of
-- the message appearing when the phone confirms.
ALTER TABLE ipy_device_send
  ADD COLUMN IF NOT EXISTS priority   text NOT NULL DEFAULT 'paced',
  ADD COLUMN IF NOT EXISTS message_id uuid REFERENCES ipy_message(id) ON DELETE SET NULL;

DO $$
BEGIN
  ALTER TABLE ipy_device_send
    ADD CONSTRAINT ipy_device_send_priority_check CHECK (priority IN ('paced', 'immediate'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The claim query orders by priority then age, and only ever looks at pending
-- rows, so the index carries both and stays partial.
DROP INDEX IF EXISTS idx_device_send_claimable;
CREATE INDEX IF NOT EXISTS idx_device_send_claimable
  ON ipy_device_send (status, assigned_to, priority, created_at)
  WHERE status = 'pending';
