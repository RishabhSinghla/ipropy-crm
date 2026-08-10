/**
 * Reading and writing the customer list.
 *
 * Its own connection pool, against `CONTROL_DATABASE_URL`. The app's `db` in
 * `db/pool.ts` is bound to whichever customer database the process is serving,
 * and the two must never be the same — `openControlPool` refuses that outright,
 * because the failure mode is one customer's database quietly holding every
 * other customer's connection string.
 */
import { Pool } from 'pg';
import { config } from '../config.js';
import { makeSecretBox } from '../core/secretbox.js';
import { logger } from '../utils/logger.js';
import { ensureControlSchema } from './schema.js';
import type { Tenant, TenantEvent, TenantStatus, TenantSummary } from './types.js';

// A different purpose from integration credentials, so a different key.
const box = makeSecretBox('ipropy-tenant-connection-strings');

let pool: Pool | null = null;

export async function openControlPool(): Promise<Pool> {
  if (pool) return pool;

  const url = config.control.databaseUrl;
  if (!url) {
    throw new Error(
      'CONTROL_DATABASE_URL is not set. In production the customer list needs its own database — see SAAS.md.',
    );
  }
  if (url === config.db.url) {
    throw new Error(
      'CONTROL_DATABASE_URL and DATABASE_URL are the same database. The customer list must not live inside a customer.',
    );
  }

  pool = new Pool({ connectionString: url, max: 4 });
  try {
    await ensureControlSchema(pool);
  } catch (err) {
    // 3D000 is "database does not exist". On a developer's machine that is not
    // a mistake, it is the first run — `docker compose up -d db` gives you one
    // Postgres server and no reason to know this second database was needed.
    // Creating it is exactly what `db:migrate` does for the CRM's own database.
    if (!config.isProd && (err as { code?: string }).code === '3D000') {
      await pool.end();
      await createControlDatabase(url);
      pool = new Pool({ connectionString: url, max: 4 });
      await ensureControlSchema(pool);
      logger.info({ database: databaseNameOf(url) }, 'created the control database');
      return pool;
    }
    pool = null;
    throw err;
  }
  return pool;
}

function databaseNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}

/**
 * `CREATE DATABASE` cannot run inside the database being created, so this
 * connects to the server's default `postgres` database to issue it. The name
 * comes from our own connection string and is quoted, not interpolated raw.
 */
async function createControlDatabase(url: string): Promise<void> {
  const name = databaseNameOf(url);
  const admin = new URL(url);
  admin.pathname = '/postgres';

  const server = new Pool({ connectionString: admin.toString(), max: 1 });
  try {
    await server.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
  } finally {
    await server.end();
  }
}

export async function closeControlPool(): Promise<void> {
  await pool?.end();
  pool = null;
}

interface Row {
  id: string; slug: string; name: string; template_key: string; status: TenantStatus;
  plan: string; admin_email: string; database_url: string; app_url: string | null;
  notes: string | null; created_at: string | Date; updated_at: string | Date;
}

/** pg returns a Date for timestamptz; the interfaces promise an ISO string. */
function iso(value: string | Date | null): string {
  if (value === null) return '';
  return value instanceof Date ? value.toISOString() : value;
}

function toTenant(row: Row): Tenant {
  return {
    id: row.id, slug: row.slug, name: row.name, templateKey: row.template_key,
    status: row.status, plan: row.plan, adminEmail: row.admin_email,
    databaseUrl: box.decrypt(row.database_url), appUrl: row.app_url, notes: row.notes,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function toSummary(tenant: Tenant): TenantSummary {
  const { databaseUrl: _omitted, ...rest } = tenant;
  return rest;
}

/**
 * Slugs become database names and subdomains, so they get Postgres's identifier
 * rules rather than a looser "URL safe" test — a slug with a dash cannot be a
 * database name without quoting, and quoting it once and forgetting later is
 * the kind of thing that fails at 2am.
 */
const SLUG = /^[a-z][a-z0-9_]{2,38}$/;

export function assertValidSlug(slug: string): void {
  if (!SLUG.test(slug)) {
    throw new Error(
      `"${slug}" is not a usable slug: lower-case letters, digits and underscores, starting with a letter, 3–39 characters.`,
    );
  }
}

export async function createTenant(input: {
  slug: string; name: string; templateKey: string; adminEmail: string;
  plan?: string; notes?: string | null;
}): Promise<Tenant> {
  assertValidSlug(input.slug);
  const db = await openControlPool();
  const res = await db.query<Row>(
    `INSERT INTO ctl_tenant (slug, name, template_key, admin_email, plan, notes)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [input.slug, input.name, input.templateKey, input.adminEmail, input.plan ?? 'trial', input.notes ?? null],
  );
  return toTenant(res.rows[0]);
}

export async function setDatabaseUrl(id: string, url: string): Promise<void> {
  const db = await openControlPool();
  await db.query(
    `UPDATE ctl_tenant SET database_url = $2, updated_at = now() WHERE id = $1`,
    [id, box.encrypt(url)],
  );
}

export async function setStatus(id: string, status: TenantStatus): Promise<void> {
  const db = await openControlPool();
  await db.query(`UPDATE ctl_tenant SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
}

export async function setAppUrl(id: string, appUrl: string): Promise<void> {
  const db = await openControlPool();
  await db.query(`UPDATE ctl_tenant SET app_url = $2, updated_at = now() WHERE id = $1`, [id, appUrl]);
}

export async function recordEvent(tenantId: string, kind: string, detail?: string): Promise<void> {
  const db = await openControlPool();
  await db.query(
    `INSERT INTO ctl_tenant_event (tenant_id, kind, detail) VALUES ($1,$2,$3)`,
    [tenantId, kind, detail ?? null],
  );
}

export async function findBySlug(slug: string): Promise<Tenant | null> {
  const db = await openControlPool();
  const res = await db.query<Row>(`SELECT * FROM ctl_tenant WHERE slug = $1`, [slug]);
  return res.rows[0] ? toTenant(res.rows[0]) : null;
}

export async function requireBySlug(slug: string): Promise<Tenant> {
  const tenant = await findBySlug(slug);
  if (!tenant) throw new Error(`No customer with the slug "${slug}".`);
  return tenant;
}

export async function listTenants(status?: TenantStatus): Promise<TenantSummary[]> {
  const db = await openControlPool();
  const res = status
    ? await db.query<Row>(`SELECT * FROM ctl_tenant WHERE status = $1 ORDER BY created_at`, [status])
    : await db.query<Row>(`SELECT * FROM ctl_tenant ORDER BY created_at`);
  return res.rows.map((row) => toSummary(toTenant(row)));
}

/** Every tenant whose database should receive a migration — suspended ones included. */
export async function listMigratable(): Promise<Tenant[]> {
  const db = await openControlPool();
  const res = await db.query<Row>(
    `SELECT * FROM ctl_tenant WHERE status IN ('active','suspended') AND database_url <> '' ORDER BY created_at`,
  );
  return res.rows.map(toTenant);
}

export async function listEvents(tenantId: string, limit = 20): Promise<TenantEvent[]> {
  const db = await openControlPool();
  const res = await db.query<{ id: string; tenant_id: string; kind: string; detail: string | null; created_at: string | Date }>(
    `SELECT * FROM ctl_tenant_event WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [tenantId, limit],
  );
  return res.rows.map((r) => ({
    id: r.id, tenantId: r.tenant_id, kind: r.kind, detail: r.detail, createdAt: iso(r.created_at),
  }));
}
