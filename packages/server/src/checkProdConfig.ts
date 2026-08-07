/**
 * CLI check: does the current environment pass the production safety guards?
 * Runs the same validation the server and worker use at boot, without
 * connecting to anything. Exit code 0 = safe to start in production.
 */
import { config, validateProductionConfig } from './config.js';

const problems = config.isProd
  ? validateProductionConfig()
  : [];

if (problems.length) {
  console.error(`NODE_ENV=${config.env} — the following production problems were found:`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('Run with a production-safe .env (see `npm run secrets:generate`).');
  process.exit(1);
}

console.log(`NODE_ENV=${config.env} — production configuration looks safe.`);
