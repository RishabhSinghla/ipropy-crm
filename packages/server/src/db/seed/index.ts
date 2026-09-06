/**
 * Seed entrypoint.
 *
 * Idempotent, and — since migration 033 — **create-only** for anything an admin
 * can edit in the UI: dashboards, workflows, views, assignment rules, message
 * templates, picklist values, profiles and sharing defaults are written when
 * absent and never rewritten. Adding to a template still reaches an existing
 * database; changing something already there does not, because the row now
 * belongs to whoever has been editing it.
 *
 * That is not a nicety. docker-entrypoint.sh runs this on every deploy *and*
 * every cold start, so anything overwritten here was being reset several times
 * a day on a free-tier instance — dashboards lost their widgets and disabled
 * workflows switched themselves back on.
 *
 * Module, field and relation *structure* is the deliberate exception: the code
 * depends on it existing, so it keeps upserting. `ipy_field.is_customised`
 * (set by the field editor) is what stops that upsert from clobbering an
 * admin's labels, validation and visibility rules along the way.
 *
 * Demo records are only created when the database has none, so a real
 * deployment never gets polluted.
 */
import { fileURLToPath } from 'node:url';
import { closePool, transaction, query } from '../pool.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';
import { registry } from '../../core/metadata/registry.js';
import { resolveTemplate } from './templates/index.js';
import { validateTemplate } from './templates/validate.js';
import { seedPicklists, seedPicklistDependencies } from './picklists.js';
import { seedDefaultLayouts, upsertModule, upsertRelations, upsertViews } from './helpers.js';
import { seedGroups, seedProfiles, seedRoles, seedSharing, seedSystemUser, seedUsers, type SeededUser } from './rbac.js';
import { seedDashboards } from './dashboards.js';
import {
  seedAssignmentRules, seedIntegrations, seedSettings, seedSlaPolicies,
  seedTemplates, seedWebforms, seedWorkflows,
} from './automation.js';
import { seedDemoData } from './demo.js';

export async function seed(): Promise<void> {
  const template = resolveTemplate(config.seed.template);

  // Checked here as well as in the unit suite: a template can arrive from a
  // branch that never ran the tests, and a bad one is not recoverable by
  // re-seeding — upserts add and update, they never remove.
  const problems = validateTemplate(template);
  if (problems.length) {
    throw new Error(`The "${template.key}" template is not sound:\n  ${problems.join('\n  ')}`);
  }

  const MODULES = template.modules;
  logger.info(`seeding iPropy CRM… (${template.label} template)`);

  // --- metadata -------------------------------------------------------------
  await transaction(async (tx) => {
    await seedPicklists(tx);
    logger.info('  picklists ✓');

    for (const def of MODULES) {
      await upsertModule(tx, def);
    }
    logger.info(`  modules ✓ (${MODULES.length})`);

    // Relations reference other modules, so they run after every module exists.
    for (const def of MODULES) {
      if (def.relations?.length) await upsertRelations(tx, def.name, def.relations);
      if (def.views?.length) await upsertViews(tx, def.name, def.views);
      await seedDefaultLayouts(tx, def);
    }
    logger.info('  relations, views and layouts ✓');

    await seedPicklistDependencies(tx);
  });

  // --- identity -------------------------------------------------------------
  const users = await transaction(async (tx) => {
    await seedSystemUser(tx);
    const roles = await seedRoles(tx);
    const profiles = await seedProfiles(tx);
    await seedSharing(tx);
    logger.info(`  roles ✓ (${roles.size})  profiles ✓ (${profiles.size})`);
    const created = await seedUsers(tx, roles, profiles, config.seed.demoData);
    /*
      Demo groups only on demo installs. On a real org they leaked into every
      owner picker as "Teams — Field Sales — West", names that mean nothing to
      this business and were never maintained. The groups engine itself stays:
      assignment rules and sharing grants may still target one, but nobody is
      offered a group as an owner by default again.
    */
    if (config.seed.demoData) await seedGroups(tx, created);
    logger.info(`  users ✓ (${created.length})`);
    return created;
  });

  // --- automation, dashboards, settings -------------------------------------
  await transaction(async (tx) => {
    await seedDashboards(tx);
    await seedWorkflows(tx);
    await seedAssignmentRules(tx);
    await seedSlaPolicies(tx);
    await seedTemplates(tx);
    await seedSettings(tx);
    await seedIntegrations(tx);
    await seedWebforms(tx);
    logger.info('  dashboards, workflows, templates and settings ✓');
  });

  // Point every seeded user at the default dashboard.
  const defaultDash = await query<{ id: string }>(`SELECT id FROM ipy_dashboard WHERE is_default = true LIMIT 1`);
  if (defaultDash.rows[0]) {
    await query(`UPDATE ipy_user SET default_dashboard_id = $1 WHERE default_dashboard_id IS NULL`, [defaultDash.rows[0].id]);
  }

  // --- demo data ------------------------------------------------------------
  if (config.seed.demoData) {
    const existing = await query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ipy_record`);
    if ((existing.rows[0]?.count ?? 0) > 0) {
      logger.info('  demo data skipped — records already present');
    } else {
      await transaction(async (tx) => {
        await seedDemoData(tx, users as SeededUser[]);
      });
      const counts = await query<{ module_name: string; count: number }>(
        `SELECT module_name, COUNT(*)::int AS count FROM ipy_record GROUP BY module_name ORDER BY 2 DESC`,
      );
      logger.info(`  demo data ✓ — ${counts.rows.map((r) => `${r.count} ${r.module_name}`).join(', ')}`);
    }
  }

  registry.invalidate();

  logger.info('');
  logger.info('iPropy is ready.');
  logger.info(`   Sign in at ${config.appUrl}`);
  logger.info(`   Email:    ${config.seed.adminEmail}`);

  /*
    The password is printed in development and never in production.
    
    In development it is the demo one, published in this repo, and having it on
    screen saves looking it up. In production it is the owner's real password,
    and this line wrote it into the deploy log on every single deploy — a log
    that is retained, readable by anyone with dashboard access, and routinely
    copied into a chat window when somebody is asking why a build failed.
    
    Nothing here needed the password. It was convenience code that followed the
    seed from a laptop onto a live server.
  */
  if (config.isProd) {
    logger.info('   Password: (set from ADMIN_PASSWORD — not printed on a live server)');
  } else {
    logger.info(`   Password: ${config.seed.adminPassword}`);
    if (config.seed.demoData) {
      logger.info('   Demo users share the same password (e.g. priya.sharma@ipropy.com — Sales Manager).');
    }
  }
  logger.info('');
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  seed()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch(async (err) => {
      logger.error({ err }, 'seed failed');
      await closePool().catch(() => undefined);
      process.exit(1);
    });
}
