/**
 * Turning "a business said yes" into a working CRM.
 *
 * The steps have always existed — create a database, migrate it, seed a
 * template, set an admin password — they were just done by hand, in the right
 * order, from memory. Doing them from memory is fine for the second customer
 * and a liability by the tenth.
 *
 * Two decisions worth knowing about:
 *
 * - **The tenant row is written before the work starts.** Provisioning takes
 *   tens of seconds and can fail in the middle. A row in `provisioning`, then
 *   `failed`, leaves a trail; doing it the other way round leaves a database
 *   nobody knows exists and nobody is paying attention to.
 * - **Migrate and seed run as child processes.** Both scripts read
 *   `DATABASE_URL` through `config`, which is resolved once at import. Spawning
 *   them with the variable overridden is what makes them point at the new
 *   database without teaching the whole app to hold two connections at once —
 *   the same reason the architecture is one database per customer.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { resolveTemplate } from '../db/seed/templates/index.js';
import { logger } from '../utils/logger.js';
import { createNeonProject } from './neon.js';
import * as store from './store.js';
import type { Tenant } from './types.js';

const run = promisify(execFile);

/** Repo root — three levels up from packages/server/src/control. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * A connection string is a password with a hostname attached. Everything that
 * logs one goes through here first.
 *
 * Parsed rather than pattern-matched, because the obvious pattern is wrong: a
 * password containing an unescaped `@` — which Postgres accepts — stops
 * `[^@]+` early and prints the rest of the password in the clear. The URL
 * parser splits on the *last* `@` before the host, the same way libpq does.
 * The regex is only a fallback for strings the parser rejects, and it is
 * greedy for the same reason: over-redacting a log line costs nothing.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.password) return url;
    parsed.password = '***';
    return parsed.toString();
  } catch {
    return url.replace(/\/\/([^:/@]+):.*@/, '//$1:***@');
  }
}

/**
 * 24 characters from a 64-character alphabet ≈ 143 bits. Generated rather than
 * chosen because the seed only ever creates the admin once: a weak password set
 * here is the customer's password until they change it.
 */
export function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
  const bytes = crypto.randomBytes(24);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

async function runAgainst(databaseUrl: string, script: string, extraEnv: Record<string, string> = {}): Promise<void> {
  const { stdout, stderr } = await run(
    'npm',
    ['run', '--silent', '--workspace', '@ipropy/server', script],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        ...extraEnv,
      },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (stdout.trim()) logger.debug({ script, stdout: stdout.slice(-2000) }, 'provision step output');
  if (stderr.trim()) logger.debug({ script, stderr: stderr.slice(-2000) }, 'provision step stderr');
}

export interface ProvisionInput {
  slug: string;
  name: string;
  adminEmail: string;
  templateKey?: string;
  plan?: string;
  /** Supply this to use a database you created yourself; otherwise Neon is asked for one. */
  databaseUrl?: string;
  notes?: string;
}

export interface ProvisionResult {
  tenant: Tenant;
  /** Shown once. Not stored anywhere — the seed has already hashed it. */
  adminPassword: string;
}

export async function provisionTenant(input: ProvisionInput): Promise<ProvisionResult> {
  store.assertValidSlug(input.slug);

  // Fail on an unknown template before creating anything: a database seeded
  // with the wrong trade cannot be re-seeded into the right one.
  const template = resolveTemplate(input.templateKey ?? config.seed.template);

  if (await store.findBySlug(input.slug)) {
    throw new Error(`A customer with the slug "${input.slug}" already exists.`);
  }

  const tenant = await store.createTenant({
    slug: input.slug,
    name: input.name,
    templateKey: template.key,
    adminEmail: input.adminEmail,
    plan: input.plan,
    notes: input.notes ?? null,
  });
  await store.recordEvent(tenant.id, 'created', `template=${template.key}`);

  const adminPassword = generatePassword();

  try {
    const databaseUrl = input.databaseUrl ?? await provisionDatabase(tenant.slug, tenant.id);
    await store.setDatabaseUrl(tenant.id, databaseUrl);
    await store.recordEvent(tenant.id, 'database_ready', redactUrl(databaseUrl));

    logger.info({ slug: tenant.slug }, 'migrating the new database');
    await runAgainst(databaseUrl, 'db:migrate');
    await store.recordEvent(tenant.id, 'migrated');

    logger.info({ slug: tenant.slug, template: template.key }, 'seeding the starting data model');
    await runAgainst(databaseUrl, 'db:seed', {
      SEED_TEMPLATE: template.key,
      SEED_ADMIN_EMAIL: input.adminEmail,
      SEED_ADMIN_PASSWORD: adminPassword,
      // A customer's database must never get the demo users — they share one
      // password that is published in this repository.
      SEED_DEMO_DATA: 'false',
    });
    await store.recordEvent(tenant.id, 'seeded', `template=${template.key}`);

    await store.setStatus(tenant.id, 'active');
    await store.recordEvent(tenant.id, 'activated');

    return { tenant: await store.requireBySlug(tenant.slug), adminPassword };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store.setStatus(tenant.id, 'failed');
    await store.recordEvent(tenant.id, 'failed', message.slice(0, 500));
    throw err;
  }
}

async function provisionDatabase(slug: string, tenantId: string): Promise<string> {
  if (!config.control.neonApiKey) {
    throw new Error(
      'No NEON_API_KEY is set, so a database cannot be created automatically. '
      + 'Create one yourself and pass --database-url, which is how the first customers should be onboarded anyway.',
    );
  }
  const project = await createNeonProject({
    apiKey: config.control.neonApiKey,
    name: `ipropy-${slug}`,
    region: config.control.neonRegion,
  });
  await store.recordEvent(tenantId, 'neon_project_created', project.projectId);
  return project.connectionUri;
}

export interface MigrationOutcome {
  slug: string;
  ok: boolean;
  error?: string;
}

/** Never throws: a caller migrating forty databases wants a report, not the first failure. */
export async function migrateTenant(tenant: Tenant): Promise<MigrationOutcome> {
  try {
    await runAgainst(tenant.databaseUrl, 'db:migrate');
    await store.recordEvent(tenant.id, 'migrated');
    return { slug: tenant.slug, ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store.recordEvent(tenant.id, 'migration_failed', message.slice(0, 500));
    return { slug: tenant.slug, ok: false, error: message };
  }
}

/**
 * Bring every customer's database up to the current migration.
 *
 * Sequential on purpose: forty databases migrating at once against one Neon
 * account is how you find their rate limit during a deploy. Failures are
 * collected rather than thrown, so one bad database does not leave the other
 * thirty-nine behind.
 */
export async function migrateAll(): Promise<MigrationOutcome[]> {
  const tenants = await store.listMigratable();
  const results: MigrationOutcome[] = [];
  for (const tenant of tenants) {
    results.push(await migrateTenant(tenant));
  }
  return results;
}
