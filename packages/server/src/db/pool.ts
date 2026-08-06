import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const { Pool, types } = pg;

// Return NUMERIC as JS numbers rather than strings. Every money column in this
// app is well inside IEEE-754 safe range (max ~9e15 paise), and the alternative
// — strings everywhere — poisons every aggregate and chart downstream.
types.setTypeParser(1700, (v: string) => (v === null ? null : Number.parseFloat(v)));
// int8/bigint: counts and ids-as-bigint stay numbers too.
types.setTypeParser(20, (v: string) => (v === null ? null : Number.parseInt(v, 10)));
// DATE: keep as a plain YYYY-MM-DD string so no timezone shifting happens.
types.setTypeParser(1082, (v: string) => v);

export const pool = new Pool({
  connectionString: config.db.url,
  max: config.db.poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'unexpected postgres pool error');
});

export type QueryParam = unknown;

export interface QueryResultLike<T> {
  rows: T[];
  rowCount: number;
}

export async function query<T = Record<string, unknown>>(
  text: string,
  params: QueryParam[] = [],
): Promise<QueryResultLike<T>> {
  const start = Date.now();
  try {
    const res = await pool.query(text, params as never[]);
    const ms = Date.now() - start;
    if (ms > 500) {
      logger.warn({ ms, sql: text.slice(0, 240) }, 'slow query');
    }
    return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
  } catch (err) {
    logger.error({ err, sql: text.slice(0, 500), params }, 'query failed');
    throw err;
  }
}

export async function queryOne<T = Record<string, unknown>>(
  text: string,
  params: QueryParam[] = [],
): Promise<T | null> {
  const res = await query<T>(text, params);
  return res.rows[0] ?? null;
}

/**
 * Run `fn` inside a transaction. The callback receives a `Tx` with the same
 * shape as the module-level helpers, so services can be written once and used
 * either standalone or inside a larger transaction.
 */
export interface Tx {
  query<T = Record<string, unknown>>(text: string, params?: QueryParam[]): Promise<QueryResultLike<T>>;
  queryOne<T = Record<string, unknown>>(text: string, params?: QueryParam[]): Promise<T | null>;
  /**
   * Marks this handle as a live transaction. Code that must not run until the
   * work is durable (event emission, background jobs) checks for it.
   */
  readonly inTransaction?: true;
}

/**
 * Work deferred until a transaction commits.
 *
 * Emitting a domain event inside an open transaction deadlocks: a workflow task
 * that updates the same row does so on a different pooled connection and blocks
 * on our uncommitted row lock. Callbacks registered here run after COMMIT and
 * are dropped on ROLLBACK.
 */
const afterCommitHooks = new WeakMap<Tx, (() => Promise<void>)[]>();

export function onCommit(conn: Tx, fn: () => Promise<void>): void {
  if (!conn.inTransaction) {
    // Not in a transaction — the write is already durable.
    void fn().catch(() => undefined);
    return;
  }
  const list = afterCommitHooks.get(conn) ?? [];
  list.push(fn);
  afterCommitHooks.set(conn, list);
}

export async function transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const tx: Tx = {
    inTransaction: true,
    async query<R = Record<string, unknown>>(text: string, params: QueryParam[] = []) {
      const res = await client.query(text, params as never[]);
      return { rows: res.rows as R[], rowCount: res.rowCount ?? 0 };
    },
    async queryOne<R = Record<string, unknown>>(text: string, params: QueryParam[] = []) {
      const res = await client.query(text, params as never[]);
      return (res.rows[0] as R) ?? null;
    },
  };

  let result: T;
  try {
    await client.query('BEGIN');
    result = await fn(tx);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    afterCommitHooks.delete(tx);
    throw err;
  } finally {
    client.release();
  }

  // Run after release so hooks can take their own connections from the pool.
  const hooks = afterCommitHooks.get(tx) ?? [];
  afterCommitHooks.delete(tx);
  for (const hook of hooks) {
    await hook().catch((err) => logger.error({ err }, 'after-commit hook failed'));
  }

  return result;
}

/** Adapter so code paths can take either the pool or an open transaction. */
export const db: Tx = { query, queryOne };

export async function checkConnection(): Promise<boolean> {
  try {
    await query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
