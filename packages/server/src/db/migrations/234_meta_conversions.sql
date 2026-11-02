-- Which good Facebook leads have been reported back to Meta, and how it went.
--
-- 2 November 2026: Meta's Conversions API, so its ads learn which leads turned
-- into site visits and sales. One row per (lead, stage) — the unique pair is the
-- guard that stops a lead moving Qualified → Contacted → Qualified being counted
-- twice. `status` says whether Meta took it; a failed row is retried the next
-- time that lead reaches that stage, and a send that died half way (`sending`
-- for over ten minutes) counts as failed.
--
-- Holds the stage and Facebook's own lead id, never a name, number or email.
-- The card in Admin → Integrations is off until somebody fills it in.
CREATE TABLE IF NOT EXISTS ipy_meta_conversion (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id   UUID NOT NULL REFERENCES ipy_record(id) ON DELETE CASCADE,
  event_name  TEXT NOT NULL,
  lead_id     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
  attempts    INTEGER NOT NULL DEFAULT 1,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at     TIMESTAMPTZ,
  UNIQUE (record_id, event_name)
);
