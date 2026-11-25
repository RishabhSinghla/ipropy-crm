/**
 * Standalone scheduler worker.
 *
 * Runs the same in-process tick as the API server (`core/workflow/scheduler.ts`)
 * but without Express/Socket.IO, so production can run a dedicated worker
 * container. Queue claims are FOR UPDATE SKIP LOCKED, so an extra worker is
 * always safe; the docker-compose setup keeps the API's scheduler off.
 */
import { mkdir } from 'node:fs/promises';
import { config, validateProductionConfig } from './config.js';
import { logger } from './utils/logger.js';
import { checkConnection, closePool } from './db/pool.js';
import { registry } from './core/metadata/registry.js';
import { warmup as warmupIntegrationSettings } from './core/settings/integrations.js';
import { registerWorkflowHandlers } from './core/workflow/engine.js';
import { startScheduler, stopScheduler } from './core/workflow/scheduler.js';

async function main(): Promise<void> {
  logger.info('starting iPropy worker…');

  if (!(await checkConnection())) {
    logger.error(
      { url: config.db.url.replace(/:[^:@]+@/, ':***@') },
      'cannot reach the database — check DATABASE_URL',
    );
    process.exit(1);
  }

  if (config.isProd) {
    const problems = validateProductionConfig();
    if (problems.length) {
      logger.error('refusing to start in production — fix these first:');
      for (const p of problems) logger.error(`  - ${p}`);
      process.exit(1);
    }
  }

  await mkdir(config.storage.localPath, { recursive: true }).catch(() => undefined);

  try {
    await registry.warmup();
    await warmupIntegrationSettings();
  } catch (err) {
    logger.error({ err }, 'failed to load metadata — have you run `npm run db:migrate && npm run db:seed`?');
    process.exit(1);
  }

  registerWorkflowHandlers();
  startScheduler();

  // The scheduler's timer is unref'd so tests/CLI exit cleanly; a real worker
  // must keep the process alive instead.
  setInterval(() => undefined, 86_400_000);

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'worker shutting down…');
    stopScheduler();
    void closePool().then(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception — exiting');
    process.exit(1);
  });
}

void main().catch((err) => {
  logger.fatal({ err }, 'failed to start worker');
  process.exit(1);
});
