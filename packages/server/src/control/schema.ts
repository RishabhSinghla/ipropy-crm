/**
 * The control-plane schema.
 *
 * Deliberately *not* part of `db/migrations/`. Those run against a customer's
 * database on every deploy; these two tables live in a separate database that
 * no customer ever connects to, and mixing them would eventually put the list
 * of every customer and their connection strings inside one customer's
 * database. `CREATE TABLE IF NOT EXISTS` is enough here — this schema is tiny,
 * changes rarely, and has exactly one writer.
 */
import type { Pool } from 'pg';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ctl_tenant (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,
  name          text NOT NULL,
  template_key  text NOT NULL,
  status        text NOT NULL DEFAULT 'provisioning',
  plan          text NOT NULL DEFAULT 'trial',
  admin_email   text NOT NULL,
  -- AES-256-GCM, same envelope as ipy_integration credentials. A plaintext
  -- column here would put every customer's database behind one stolen backup
  -- of this table.
  database_url  text NOT NULL DEFAULT '',
  app_url       text,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ctl_tenant_event (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES ctl_tenant(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  detail     text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ctl_tenant_event_tenant_idx ON ctl_tenant_event (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ctl_tenant_status_idx ON ctl_tenant (status);

CREATE TABLE IF NOT EXISTS ctl_subscription (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL UNIQUE REFERENCES ctl_tenant(id) ON DELETE CASCADE,
  plan_key               text NOT NULL,
  -- Null while a customer is on trial or paying by invoice: not every paying
  -- customer will come through the gateway, and the first few certainly won't.
  razorpay_subscription_id text UNIQUE,
  status                 text NOT NULL DEFAULT 'trialing',
  -- When service stops if nothing else changes. Renewed on every successful
  -- charge; the grace period is added to it on a failed one.
  serves_until           timestamptz,
  last_payment_at        timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Razorpay retries a delivery until it gets a 2xx, so the same event arrives
-- more than once as a matter of course. Without this table a retried
-- subscription.charged extends the period twice.
CREATE TABLE IF NOT EXISTS ctl_webhook_event (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    text NOT NULL,
  -- Razorpay's x-razorpay-event-id header; the payload id when it is absent.
  external_id text NOT NULL,
  kind        text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);

CREATE TABLE IF NOT EXISTS ctl_signup_request (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL,
  name         text NOT NULL,
  admin_email  text NOT NULL,
  template_key text NOT NULL,
  plan_key     text NOT NULL,
  phone        text,
  -- 'pending' until a human approves. Provisioning creates a database and costs
  -- money, so a public form may only ever queue a request.
  status       text NOT NULL DEFAULT 'pending',
  tenant_id    uuid REFERENCES ctl_tenant(id) ON DELETE SET NULL,
  decided_at   timestamptz,
  decided_note text,
  source_ip    text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ctl_signup_status_idx ON ctl_signup_request (status, created_at);
`;

export async function ensureControlSchema(pool: Pool): Promise<void> {
  await pool.query(SCHEMA);
}
