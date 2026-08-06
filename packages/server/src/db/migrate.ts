/**
 * Minimal forward-only migration runner.
 *
 * Reads every .sql file in ./migrations in name order, applies the ones not yet
 * recorded in ipy_migration, each inside its own transaction. Deliberately not
 * a full framework — the schema is owned by this repo and applied linearly.
 *
 *   npm run db:migrate            apply pending migrations
 *   npm run db:migrate -- --reset drop the public schema first (destructive)
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query, transaction, closePool } from './pool.js';
import { logger } from '../utils/logger.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, 'migrations');

async function ensureMigrationTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS ipy_migration (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedMigrations(): Promise<Set<string>> {
  const res = await query<{ name: string }>('SELECT name FROM ipy_migration');
  return new Set(res.rows.map((r) => r.name));
}

async function resetSchema(): Promise<void> {
  logger.warn('--reset: dropping and recreating the public schema');
  await query('DROP SCHEMA public CASCADE');
  await query('CREATE SCHEMA public');
  // Re-grant so the app role keeps working after the drop.
  const { rows } = await query<{ current_user: string }>('SELECT current_user');
  const role = rows[0]?.current_user;
  if (role) {
    await query(`GRANT ALL ON SCHEMA public TO ${JSON.stringify(role).replace(/"/g, '"')}`);
  }
  await query('GRANT ALL ON SCHEMA public TO public');
}

export async function runMigrations(reset = false): Promise<{ applied: string[]; skipped: string[] }> {
  if (reset) await resetSchema();
  await ensureMigrationTable();

  const done = await appliedMigrations();
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (done.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    logger.info({ file }, 'applying migration');
    await transaction(async (tx) => {
      await tx.query(sql);
      await tx.query('INSERT INTO ipy_migration (name) VALUES ($1)', [file]);
    });
    applied.push(file);
  }

  return { applied, skipped };
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  const reset = process.argv.includes('--reset');
  runMigrations(reset)
    .then(({ applied, skipped }) => {
      if (applied.length === 0) {
        logger.info(`database already up to date (${skipped.length} migrations)`);
      } else {
        logger.info(`applied ${applied.length} migration(s): ${applied.join(', ')}`);
      }
      return closePool();
    })
    .then(() => process.exit(0))
    .catch(async (err) => {
      logger.error({ err }, 'migration failed');
      await pool.end().catch(() => undefined);
      process.exit(1);
    });
}
