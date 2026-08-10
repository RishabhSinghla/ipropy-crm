/**
 * `npm run tenant -- <command>` — the operator's side of the product.
 *
 * Deliberately a command line and not a screen. Provisioning runs migrations
 * and seeds a database; it belongs on a machine with the repository checked
 * out, not behind a button on the public internet where a script can press it
 * a thousand times. When self-serve sign-up arrives it should call this same
 * code behind a queue and an approval, not replace it.
 */
import { config } from '../config.js';
import { listTemplates, resolveTemplate } from '../db/seed/templates/index.js';
import { logger } from '../utils/logger.js';
import { migrateAll, migrateTenant, provisionTenant, redactUrl } from './provision.js';
import * as store from './store.js';
import type { TenantStatus } from './types.js';

interface Args {
  command: string;
  flags: Record<string, string>;
}

function parse(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = 'true';
    }
  }
  return { command, flags };
}

function required(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (!value || value === 'true') throw new Error(`--${name} is required`);
  return value;
}

const HELP = `
iPropy customers

  npm run tenant -- list [--status active|suspended|provisioning|failed|archived]
  npm run tenant -- show --slug acme
  npm run tenant -- create --slug acme --name "Acme Realty" --admin-email ops@acme.com
                           [--template real-estate] [--plan trial]
                           [--database-url postgres://…]  (skips Neon; use this first)
  npm run tenant -- migrate [--slug acme]      bring one or every database up to date
  npm run tenant -- suspend --slug acme        stops service, keeps the data
  npm run tenant -- resume  --slug acme
  npm run tenant -- templates                  the trades a new customer can start from

CONTROL_DATABASE_URL must point at the customer list's own database — never at
a customer's. NEON_API_KEY is optional; without it, pass --database-url.
`.trim();

async function main(): Promise<void> {
  const { command, flags } = parse(process.argv.slice(2));

  switch (command) {
    case 'templates': {
      for (const template of listTemplates()) {
        process.stdout.write(`${template.key.padEnd(16)} ${template.label} — ${template.description}\n`);
      }
      return;
    }

    case 'list': {
      const tenants = await store.listTenants(flags.status as TenantStatus | undefined);
      if (!tenants.length) {
        process.stdout.write('No customers yet.\n');
        return;
      }
      for (const t of tenants) {
        process.stdout.write(
          `${t.slug.padEnd(20)} ${t.status.padEnd(13)} ${t.plan.padEnd(10)} ${t.templateKey.padEnd(14)} ${t.name}\n`,
        );
      }
      return;
    }

    case 'show': {
      const tenant = await store.requireBySlug(required(flags, 'slug'));
      const events = await store.listEvents(tenant.id);
      process.stdout.write(`${tenant.name} (${tenant.slug})\n`);
      process.stdout.write(`  status    ${tenant.status}\n`);
      process.stdout.write(`  plan      ${tenant.plan}\n`);
      process.stdout.write(`  template  ${tenant.templateKey}\n`);
      process.stdout.write(`  admin     ${tenant.adminEmail}\n`);
      process.stdout.write(`  database  ${tenant.databaseUrl ? redactUrl(tenant.databaseUrl) : '(none yet)'}\n`);
      process.stdout.write(`  app       ${tenant.appUrl ?? '(not deployed)'}\n`);
      process.stdout.write('  history\n');
      for (const event of events) {
        process.stdout.write(`    ${event.createdAt}  ${event.kind}${event.detail ? `  ${event.detail}` : ''}\n`);
      }
      return;
    }

    case 'create': {
      const template = resolveTemplate(flags.template ?? config.seed.template);
      const result = await provisionTenant({
        slug: required(flags, 'slug'),
        name: required(flags, 'name'),
        adminEmail: required(flags, 'admin-email'),
        templateKey: template.key,
        plan: flags.plan,
        databaseUrl: flags['database-url'] === 'true' ? undefined : flags['database-url'],
        notes: flags.notes,
      });

      process.stdout.write(`\n${result.tenant.name} is ready.\n\n`);
      process.stdout.write(`  sign in as  ${result.tenant.adminEmail}\n`);
      process.stdout.write(`  password    ${result.adminPassword}\n\n`);
      // Said plainly because the seed hashes it and moves on — there is no
      // second chance to read it, and no reset flow yet.
      process.stdout.write('That password is shown once and is not stored anywhere. Send it to them now.\n');
      return;
    }

    case 'migrate': {
      if (flags.slug && flags.slug !== 'true') {
        const result = await migrateTenant(await store.requireBySlug(flags.slug));
        process.stdout.write(`${result.slug}: ${result.ok ? 'up to date' : `FAILED — ${result.error}`}\n`);
        if (!result.ok) process.exitCode = 1;
        return;
      }
      const results = await migrateAll();
      for (const r of results) {
        process.stdout.write(`${r.slug.padEnd(20)} ${r.ok ? 'up to date' : `FAILED — ${r.error}`}\n`);
      }
      if (results.some((r) => !r.ok)) process.exitCode = 1;
      return;
    }

    case 'suspend':
    case 'resume': {
      const tenant = await store.requireBySlug(required(flags, 'slug'));
      const status: TenantStatus = command === 'suspend' ? 'suspended' : 'active';
      await store.setStatus(tenant.id, status);
      await store.recordEvent(tenant.id, command, flags.reason);
      process.stdout.write(`${tenant.slug} is now ${status}.\n`);
      return;
    }

    default:
      process.stdout.write(`${HELP}\n`);
  }
}

main()
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'tenant command failed');
    process.stderr.write(`\n${message}\n`);
    process.exitCode = 1;
  })
  .finally(() => store.closeControlPool());
