/**
 * Seed entrypoint.
 *
 * Idempotent: every step upserts, so running it again after a schema change
 * refreshes metadata without wiping the tenant's data. Demo records are only
 * created when the database has none, so a real deployment never gets polluted.
 */
import { fileURLToPath } from 'node:url';
import { closePool, transaction, query } from '../pool.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';
import { registry } from '../../core/metadata/registry.js';
import { MODULES } from './modules.js';
import { seedPicklists, seedPicklistDependencies } from './picklists.js';
import { seedDefaultLayouts, upsertModule, upsertRelations, upsertViews } from './helpers.js';
import { seedGroups, seedProfiles, seedRoles, seedSharing, seedSystemUser, seedUsers, type SeededUser, DEMO_USERS } from './rbac.js';
import { seedDashboards } from './dashboards.js';
import {
  seedAssignmentRules, seedIntegrations, seedSettings, seedSlaPolicies,
  seedTemplates, seedWebforms, seedWorkflows,
} from './automation.js';
import { seedDemoData } from './demo.js';

export async function seed(): Promise<void> {
  logger.info('seeding iPropy CRM…');

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
    await seedGroups(tx, created);
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
  logger.info(`   Password: ${config.seed.adminPassword}`);
  if (config.seed.demoData) {
    logger.info('   Demo users share the same password (e.g. priya.sharma@ipropy.com — Sales Head).');
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
