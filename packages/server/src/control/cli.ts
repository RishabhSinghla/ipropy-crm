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
import { attachRazorpaySubscription, markInvoiced, startTrial, suspendLapsed } from './billing.js';
import { DEFAULT_PLAN, formatPrice, parsePlanIds, PLANS, resolvePlan } from './plans.js';
import { migrateAll, migrateTenant, provisionTenant, redactUrl } from './provision.js';
import { createPlan, createSubscription } from './razorpay.js';
import { approveSignup, listSignups, rejectSignup } from './signups.js';
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

Billing

  npm run tenant -- plans                      what a customer can buy
  npm run tenant -- billing-setup              create the plans at Razorpay, once
  npm run tenant -- subscribe --slug acme --plan starter
  npm run tenant -- invoice   --slug acme --plan starter --days 365
  npm run tenant -- trial     --slug acme [--plan trial] [--days 30]
  npm run tenant -- lapse                      suspend everyone whose paid time ran out

Sign-ups

  npm run tenant -- signups                    what is waiting for a decision
  npm run tenant -- approve --id <uuid>        provisions for real
  npm run tenant -- reject  --id <uuid> [--note "…"]

CONTROL_DATABASE_URL must point at the customer list's own database — never at
a customer's. NEON_API_KEY is optional; without it, pass --database-url.
Razorpay is optional too: with no keys, invoice and trial still work.
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

    case 'plans': {
      for (const plan of Object.values(PLANS)) {
        process.stdout.write(
          `${plan.key.padEnd(10)} ${formatPrice(plan).padStart(9)}/mo  ${String(plan.seats).padStart(3)} seats  ${plan.blurb}\n`,
        );
      }
      return;
    }

    case 'billing-setup': {
      // Run once. The ids it prints go in RAZORPAY_PLAN_IDS; running it again
      // creates a second set of plans at Razorpay, which is confusing but not
      // dangerous — nothing points at them until the variable changes.
      const created: string[] = [];
      for (const plan of Object.values(PLANS)) {
        if (!plan.amountPaise) continue;
        const remote = await createPlan(plan);
        created.push(`${plan.key}=${remote.id}`);
        process.stdout.write(`${plan.key.padEnd(10)} ${formatPrice(plan)}/mo → ${remote.id}\n`);
      }
      process.stdout.write(`\nRAZORPAY_PLAN_IDS=${created.join(',')}\n`);
      return;
    }

    case 'subscribe': {
      const tenant = await store.requireBySlug(required(flags, 'slug'));
      const plan = resolvePlan(required(flags, 'plan'));
      const planIds = parsePlanIds(config.billing.planIds);
      const razorpayPlanId = planIds[plan.key];
      if (!razorpayPlanId) {
        throw new Error(
          `No Razorpay plan id for "${plan.key}". Run billing-setup and put the output in RAZORPAY_PLAN_IDS.`,
        );
      }

      const subscription = await createSubscription({
        razorpayPlanId,
        notifyEmail: tenant.adminEmail,
        notes: { slug: tenant.slug, tenant_id: tenant.id },
      });
      await attachRazorpaySubscription(tenant.id, plan.key, subscription.id);
      await store.recordEvent(tenant.id, 'billing:subscription_created', `${plan.key} ${subscription.id}`);

      process.stdout.write(`\n${tenant.name} → ${plan.label} at ${formatPrice(plan)}/month\n`);
      process.stdout.write(`  subscription  ${subscription.id}\n`);
      process.stdout.write(`  send them     ${subscription.short_url ?? '(no link returned)'}\n\n`);
      // Until they authorise the mandate nothing is charged and no webhook
      // arrives, so a subscription sitting unused is expected, not a fault.
      process.stdout.write('They authorise the mandate at that link. Service continues on trial until they do.\n');
      return;
    }

    case 'invoice': {
      const tenant = await store.requireBySlug(required(flags, 'slug'));
      const plan = resolvePlan(required(flags, 'plan'));
      const days = Number(flags.days ?? '365');
      const until = new Date(Date.now() + days * 86_400_000);
      await markInvoiced(tenant.id, plan.key, until);
      await store.recordEvent(tenant.id, 'billing:invoiced', `${plan.key} until ${until.toISOString().slice(0, 10)}`);
      process.stdout.write(`${tenant.slug} is on ${plan.label}, paid outside the gateway until ${until.toDateString()}.\n`);
      return;
    }

    case 'trial': {
      const tenant = await store.requireBySlug(required(flags, 'slug'));
      const plan = resolvePlan(flags.plan ?? DEFAULT_PLAN);
      const subscription = await startTrial(tenant.id, plan.key, Number(flags.days ?? '30'));
      process.stdout.write(`${tenant.slug} is trialing ${plan.label} until ${subscription.servesUntil}.\n`);
      return;
    }

    case 'lapse': {
      const suspended = await suspendLapsed();
      process.stdout.write(suspended.length
        ? `Suspended: ${suspended.join(', ')}\n`
        : 'Nobody has lapsed.\n');
      return;
    }

    case 'signups': {
      const pending = await listSignups((flags.status as 'pending' | 'approved' | 'rejected') ?? 'pending');
      if (!pending.length) {
        process.stdout.write('Nothing waiting.\n');
        return;
      }
      for (const r of pending) {
        process.stdout.write(`${r.id}  ${r.slug.padEnd(20)} ${r.planKey.padEnd(9)} ${r.adminEmail.padEnd(28)} ${r.name}\n`);
      }
      return;
    }

    case 'approve': {
      const result = await approveSignup(required(flags, 'id'));
      process.stdout.write(`\n${result.request.name} is ready.\n\n`);
      process.stdout.write(`  sign in as  ${result.request.adminEmail}\n`);
      process.stdout.write(`  password    ${result.adminPassword}\n\n`);
      process.stdout.write('That password is shown once and is not stored anywhere. Send it to them now.\n');
      return;
    }

    case 'reject': {
      await rejectSignup(required(flags, 'id'), flags.note);
      process.stdout.write('Rejected.\n');
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
