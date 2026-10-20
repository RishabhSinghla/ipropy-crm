/**
 * "Is Jev working, how much has it done, how much is left, and what is it costing me?" — one answer.
 *
 * The owner, 20 October 2026: *"how much JEV worked, how much left, how much working on … simply easily visible."* The three
 * words a pairing used to carry (rated, "checking", "not checked yet") meant several different things; this names them.
 */
import { db } from '../../db/pool.js';
import { jevActivity, JEV_USD_PER_MILLION_TOKENS } from './jev.js';
import { jevCounts, type JevCounts } from './crossMatch.js';
import { GIVE_UP_AFTER } from './enrich.js';

export interface JevStatus {
  connection: { connected: boolean; via: 'typesafe' | 'openrouter' | null; model: string | null; lastOkAt: string | null; lastError: { at: string; message: string } | null };
  /** The call sheet's pairings: how many Jev has rated, how many wait their turn, how many it could not answer. */
  pairings: JevCounts & { checkingNow: number };
  /** The messages themselves: read by Jev (what kind of post, sale or rent, what property), waiting, given up on. */
  messages: { read: number; waiting: number; gaveUp: number };
  today: { calls: number; failed: number; tokens: number; costUsd: number };
  week: { calls: number; costUsd: number };
}

const cost = (tokens: number): number => Math.round((tokens / 1_000_000) * JEV_USD_PER_MILLION_TOKENS * 10_000) / 10_000;

export async function jevStatus(): Promise<JevStatus> {
  const activity = jevActivity();
  const [pairings, messages, usage] = await Promise.all([
    jevCounts(),
    db.queryOne<{ read: number; waiting: number; gave_up: number }>(
      `SELECT count(*) FILTER (WHERE jev_checked_at IS NOT NULL)::int AS read,
              count(*) FILTER (WHERE jev_checked_at IS NULL AND NOT is_noise AND jev_attempts < $1)::int AS waiting,
              count(*) FILTER (WHERE jev_checked_at IS NULL AND NOT is_noise AND jev_attempts >= $1)::int AS gave_up
         FROM ipy_market_post`, [GIVE_UP_AFTER]),
    db.query<{ today: boolean; calls: number; failed: number; tokens: string }>(
      `SELECT (day = (now() AT TIME ZONE 'Asia/Kolkata')::date) AS today, sum(calls)::int AS calls, sum(failed)::int AS failed, sum(input_tokens)::text AS tokens
         FROM ipy_market_jev_usage WHERE day > (now() AT TIME ZONE 'Asia/Kolkata')::date - 7 GROUP BY 1`),
  ]);
  const todayRow = usage.rows.find((row) => row.today);
  const weekCalls = usage.rows.reduce((sum, row) => sum + row.calls, 0);
  const weekTokens = usage.rows.reduce((sum, row) => sum + Number(row.tokens), 0);
  return {
    connection: { connected: activity.via !== null, via: activity.via, model: activity.model, lastOkAt: activity.lastOkAt, lastError: activity.lastError },
    pairings: { ...pairings, checkingNow: activity.inFlight },
    messages: { read: messages?.read ?? 0, waiting: messages?.waiting ?? 0, gaveUp: messages?.gave_up ?? 0 },
    today: { calls: todayRow?.calls ?? 0, failed: todayRow?.failed ?? 0, tokens: Number(todayRow?.tokens ?? 0), costUsd: cost(Number(todayRow?.tokens ?? 0)) },
    week: { calls: weekCalls, costUsd: cost(weekTokens) },
  };
}
