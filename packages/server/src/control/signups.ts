/**
 * The queue between "someone filled in a form" and "a database exists".
 *
 * Provisioning creates a Neon project and costs money on every call, so a public
 * endpoint may only ever *record a request*. A human approves it and the same
 * `provisionTenant` the command line uses does the work. When that approval is
 * eventually automated it should be automated behind a payment, not behind a
 * click.
 */
import { openControlPool } from './store.js';
import * as store from './store.js';
import { provisionTenant } from './provision.js';
import { resolvePlan } from './plans.js';
import { resolveTemplate } from '../db/seed/templates/index.js';
import { startTrial } from './billing.js';
import { logger } from '../utils/logger.js';

export type SignupStatus = 'pending' | 'approved' | 'rejected';

export interface SignupRequest {
  id: string;
  slug: string;
  name: string;
  adminEmail: string;
  templateKey: string;
  planKey: string;
  phone: string | null;
  status: SignupStatus;
  tenantId: string | null;
  createdAt: string;
}

interface Row {
  id: string; slug: string; name: string; admin_email: string; template_key: string;
  plan_key: string; phone: string | null; status: SignupStatus; tenant_id: string | null;
  created_at: string;
}

const toRequest = (r: Row): SignupRequest => ({
  id: r.id, slug: r.slug, name: r.name, adminEmail: r.admin_email,
  templateKey: r.template_key, planKey: r.plan_key, phone: r.phone,
  status: r.status, tenantId: r.tenant_id, createdAt: r.created_at,
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function submitSignup(input: {
  slug: string; name: string; adminEmail: string;
  templateKey?: string; planKey?: string; phone?: string; sourceIp?: string;
}): Promise<SignupRequest> {
  store.assertValidSlug(input.slug);
  if (!EMAIL.test(input.adminEmail)) throw new Error('That email address does not look right.');
  if (!input.name.trim()) throw new Error('A business name is required.');

  // Both throw on anything unknown, so a crafted request cannot queue a signup
  // that can never be approved.
  const template = resolveTemplate(input.templateKey ?? 'real-estate');
  const plan = resolvePlan(input.planKey ?? 'trial');

  // Checked here for a civil error message; the unique constraint on ctl_tenant
  // is what actually prevents a collision at approval time.
  if (await store.findBySlug(input.slug)) {
    throw new Error(`The name "${input.slug}" is taken.`);
  }

  const db = await openControlPool();
  const res = await db.query<Row>(
    `INSERT INTO ctl_signup_request (slug, name, admin_email, template_key, plan_key, phone, source_ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [input.slug, input.name.trim(), input.adminEmail.toLowerCase(), template.key, plan.key,
      input.phone ?? null, input.sourceIp ?? null],
  );

  logger.info({ slug: input.slug, plan: plan.key }, 'sign-up request queued');
  return toRequest(res.rows[0]);
}

export async function listSignups(status: SignupStatus = 'pending'): Promise<SignupRequest[]> {
  const db = await openControlPool();
  const res = await db.query<Row>(
    `SELECT * FROM ctl_signup_request WHERE status = $1 ORDER BY created_at`,
    [status],
  );
  return res.rows.map(toRequest);
}

/** Provisions for real. The one place a queued request turns into a database. */
export async function approveSignup(id: string): Promise<{ request: SignupRequest; adminPassword: string }> {
  const db = await openControlPool();
  const found = await db.query<Row>(`SELECT * FROM ctl_signup_request WHERE id = $1`, [id]);
  const request = found.rows[0];
  if (!request) throw new Error(`No sign-up request with the id ${id}.`);
  if (request.status !== 'pending') throw new Error(`That request is already ${request.status}.`);

  const result = await provisionTenant({
    slug: request.slug,
    name: request.name,
    adminEmail: request.admin_email,
    templateKey: request.template_key,
    plan: request.plan_key,
  });
  await startTrial(result.tenant.id, request.plan_key);

  const updated = await db.query<Row>(
    `UPDATE ctl_signup_request
        SET status = 'approved', tenant_id = $2, decided_at = now()
      WHERE id = $1 RETURNING *`,
    [id, result.tenant.id],
  );

  return { request: toRequest(updated.rows[0]), adminPassword: result.adminPassword };
}

export async function rejectSignup(id: string, note?: string): Promise<void> {
  const db = await openControlPool();
  const res = await db.query(
    `UPDATE ctl_signup_request SET status = 'rejected', decided_at = now(), decided_note = $2
      WHERE id = $1 AND status = 'pending'`,
    [id, note ?? null],
  );
  if (!res.rowCount) throw new Error('No pending request with that id.');
}
