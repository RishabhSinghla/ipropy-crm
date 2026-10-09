-- Durable delivery before HTTP acknowledgement; no customer data is deleted.
CREATE TABLE ipy_facebook_delivery (
  lead_id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','dead')),
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_facebook_due ON ipy_facebook_delivery(next_attempt_at) WHERE status <> 'done';
ALTER TABLE ipy_comment ADD COLUMN facebook_lead_id TEXT;
CREATE UNIQUE INDEX idx_comment_facebook_delivery ON ipy_comment(facebook_lead_id) WHERE facebook_lead_id IS NOT NULL;
CREATE TABLE ipy_facebook_health (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  last_reconciled_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  token_expires_at TIMESTAMPTZ,
  data_access_expires_at TIMESTAMPTZ,
  graph_version TEXT,
  forms JSONB NOT NULL DEFAULT '[]',
  issues JSONB NOT NULL DEFAULT '{}',
  assignment_rule_id UUID REFERENCES ipy_assignment_rule(id) ON DELETE SET NULL
);
INSERT INTO ipy_facebook_health (assignment_rule_id)
SELECT (SELECT id FROM ipy_assignment_rule WHERE name = 'Facebook leads to Shikha Jha' ORDER BY sequence LIMIT 1);
CREATE TABLE ipy_facebook_alert (
  key TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  last_notified_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ
);
-- Recover previously interrupted/failed deliveries, including ID-only payloads.
INSERT INTO ipy_facebook_delivery (lead_id, payload)
SELECT external_id, raw_payload FROM ipy_lead_inbox
WHERE source = 'facebook' AND external_id ~ '^[0-9]+$' AND status IN ('pending','failed')
ON CONFLICT DO NOTHING;
