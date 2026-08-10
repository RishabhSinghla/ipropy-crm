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
`;

export async function ensureControlSchema(pool: Pool): Promise<void> {
  await pool.query(SCHEMA);
}
