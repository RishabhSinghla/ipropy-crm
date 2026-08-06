import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { createApp } from './app.js';
import { checkConnection, closePool } from './db/pool.js';
import { registry } from './core/metadata/registry.js';
import { registerWorkflowHandlers } from './core/workflow/engine.js';
import { startScheduler, stopScheduler } from './core/workflow/scheduler.js';
import { initRealtime, closeRealtime } from './realtime.js';

async function main(): Promise<void> {
  logger.info('starting iPropy CRM server…');

  if (!(await checkConnection())) {
    logger.error(
      { url: config.db.url.replace(/:[^:@]+@/, ':***@') },
      'cannot reach the database — start Postgres (docker compose up -d db) and check DATABASE_URL',
    );
    process.exit(1);
  }

  // Fail loudly rather than shipping the dev secret to production.
  if (config.isProd && config.auth.jwtSecret === 'dev-only-insecure-secret-change-me') {
    logger.error('JWT_SECRET is still the development default — set a strong secret before running in production');
    process.exit(1);
  }

  await mkdir(config.storage.localPath, { recursive: true }).catch(() => undefined);

  try {
    await registry.warmup();
  } catch (err) {
    logger.error({ err }, 'failed to load metadata — have you run `npm run db:migrate && npm run db:seed`?');
    process.exit(1);
  }

  registerWorkflowHandlers();

  const app = createApp();
  const server = createServer(app);
  initRealtime(server);
  startScheduler();

  server.listen(config.port, () => {
    logger.info(`iPropy API listening on http://localhost:${config.port}`);
    logger.info(`   health:  http://localhost:${config.port}/api/health`);
    logger.info(`   web app: ${config.appUrl}`);
    if (!config.ai.apiKey) {
      logger.warn('   ANTHROPIC_API_KEY is not set — AI features fall back to rule-based behaviour');
    }
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down…');
    stopScheduler();
    closeRealtime();
    server.close(() => {
      void closePool().then(() => process.exit(0));
    });
    // Don't hang forever on a stuck connection.
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
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
