import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { config, validateProductionConfig } from './config.js';
import { logger } from './utils/logger.js';
import { createApp } from './app.js';
import { checkConnection, closePool } from './db/pool.js';
import { registry } from './core/metadata/registry.js';
import { warmup as warmupIntegrationSettings } from './core/settings/integrations.js';
import { registerWorkflowHandlers } from './core/workflow/engine.js';
import { registerLifecycleSync } from './core/entity/lifecycleFromStatus.js';
import { startScheduler, stopScheduler } from './core/workflow/scheduler.js';
import { initRealtime, closeRealtime } from './realtime.js';
import { aiStatus } from './ai/client.js';

async function main(): Promise<void> {
  logger.info('starting iPropy CRM server…');

  if (!(await checkConnection())) {
    logger.error(
      { url: config.db.url.replace(/:[^:@]+@/, ':***@') },
      'cannot reach the database — start Postgres (docker compose up -d db) and check DATABASE_URL',
    );
    process.exit(1);
  }

  // Fail loudly rather than shipping development defaults to production.
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
  // After the workflows, so a workflow that sets the status gets the stage move too.
  registerLifecycleSync();

  const app = createApp();
  const server = createServer(app);
  initRealtime(server);
  startScheduler();

  server.listen(config.port, () => {
    logger.info(`iPropy API listening on http://localhost:${config.port}`);
    logger.info(`   health:  http://localhost:${config.port}/api/health`);
    logger.info(`   web app: ${config.appUrl}`);
    const ai = aiStatus();
    if (ai.available) {
      logger.info(`   AI:      ${ai.provider} — ${ai.model}`);
    } else {
      logger.warn('   no AI provider configured — AI features fall back to rule-based behaviour');
      logger.warn('   set one in Admin → Integrations (Gemini, Groq and OpenRouter have free tiers)');
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
