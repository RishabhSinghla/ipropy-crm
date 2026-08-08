-- ===========================================================================
-- iPropy CRM — 019: WhatsApp consent trail and keyword auto-replies
--
-- Two things a WhatsApp marketing stack cannot ship without.
--
-- 1. **Consent.** `do_not_whatsapp` already existed on leads but nothing on the
--    send path read it, so a broadcast would have messaged people who had opted
--    out. Under Meta's Business Messaging policy that is the fastest route to a
--    number being restricted or banned — and the number is the asset. This
--    table records *why* and *when* consent changed, because "we did not
--    message them" is a claim you have to be able to evidence.
--
-- 2. **Auto-replies.** The ManyChat-style half: an inbound keyword triggers a
--    reply without anyone at a desk. Deliberately rules, not a flow chart — a
--    property desk answers the same eight questions ("price?", "location?",
--    "brochure", "site visit") and a rule table is something a salesperson can
--    edit, where a node graph is not.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS ipy_consent_event (
  id           BIGSERIAL PRIMARY KEY,
  record_id    UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  handle       TEXT NOT NULL,
  channel      TEXT NOT NULL DEFAULT 'whatsapp',
  -- 'opt_out' | 'opt_in'
  action       TEXT NOT NULL,
  -- 'keyword' (they texted STOP) | 'manual' | 'import' | 'api'
  source       TEXT NOT NULL DEFAULT 'keyword',
  message_text TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consent_handle ON ipy_consent_event(handle, created_at DESC);

-- Opt-out has to work for a number we hold no lead for: someone can text STOP
-- from a number that never became a record, and we must still honour it.
CREATE TABLE IF NOT EXISTS ipy_channel_optout (
  handle     TEXT NOT NULL,
  channel    TEXT NOT NULL DEFAULT 'whatsapp',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (handle, channel)
);

CREATE TABLE IF NOT EXISTS ipy_autoreply_rule (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  -- Lower runs first; the first match wins, so ordering is the whole design.
  sequence     INT NOT NULL DEFAULT 100,
  -- 'keyword' matches any of `keywords`; 'welcome' fires on a first-ever
  -- message; 'fallback' fires when nothing else matched.
  trigger_type TEXT NOT NULL DEFAULT 'keyword',
  keywords     JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Reply body; supports the same {{merge}} tokens workflows use.
  reply_text   TEXT NOT NULL,
  -- Optional quick-reply buttons, so a reply can branch without free text.
  buttons      JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Only reply inside business hours if set; outside them the fallback runs.
  business_hours_only BOOLEAN NOT NULL DEFAULT false,
  match_count  INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_autoreply_active ON ipy_autoreply_rule(is_active, sequence);

-- Marks a message as machine-sent, which the cooldown reads and the inbox can
-- show — a rep needs to know at a glance whether the bot already replied.
ALTER TABLE ipy_message ADD COLUMN IF NOT EXISTS is_auto_reply BOOLEAN NOT NULL DEFAULT false;

-- 'blocked' joins the status vocabulary: a send refused on consent grounds is
-- not a failure to retry, it is a decision to record.
CREATE INDEX IF NOT EXISTS idx_message_autoreply
  ON ipy_message(conversation_id, created_at DESC) WHERE is_auto_reply;

-- Starter rules, switched on, so the channel answers sensibly from minute one.
-- Ordinary rows: an admin can reword, reorder or delete any of them.
INSERT INTO ipy_autoreply_rule (name, sequence, trigger_type, keywords, reply_text) VALUES
  ('Price enquiry', 10, 'keyword',
   '["price","rate","cost","kitna","kitne ka","budget"]'::jsonb,
   'Hi {{first_name}}, thanks for asking! Our builder floors in Greenfields Colony start around ₹1.65 Cr for a 3 BHK on 200 sq yd. May I share the full price list and floor plans?'),
  ('Location enquiry', 20, 'keyword',
   '["location","address","where","kahan","map","directions"]'::jsonb,
   'We are in Greenfields Colony, Faridabad — about 1 km from Surajkund, with easy access to Delhi, Noida and Gurugram. Would you like the exact location pin?'),
  ('Site visit', 30, 'keyword',
   '["visit","site visit","viewing","see the property","dekhna"]'::jsonb,
   'Happy to arrange a site visit, {{first_name}}. Which day suits you — this weekend or a weekday? We can also arrange pickup.'),
  ('Brochure', 40, 'keyword',
   '["brochure","details","floor plan","layout","pdf"]'::jsonb,
   'Sure — sending the brochure and floor plans across now. Is there a particular configuration you have in mind, 3 BHK or 4 BHK?'),
  ('Fallback', 900, 'fallback', '[]'::jsonb,
   'Thanks for reaching out to {{org_name}}! One of our property advisors will reply shortly. Meanwhile, feel free to tell us what you are looking for — configuration, budget and preferred possession.')
ON CONFLICT DO NOTHING;
