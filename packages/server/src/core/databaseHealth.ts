/*
  "Is the database reachable?" for the health endpoint, without asking every time.

  Render calls /api/health every few seconds to see whether the server is alive.
  Answering that with a real `SELECT 1` each time meant Neon never had five
  quiet minutes to power down, so the database was billed for 24 hours a day
  whether or not anybody was using the CRM. A good answer is now remembered for
  ten minutes, so the database gets a real visit at most six times an hour.

  A bad answer is remembered for only fifteen seconds, so recovery shows quickly,
  and `fresh` skips the memory for anyone who really wants to know right now.
*/
export const REMEMBER_GOOD_MS = 10 * 60_000;
export const REMEMBER_BAD_MS = 15_000;

export function makeDatabaseHealth(
  askTheDatabase: () => Promise<boolean>,
  now: () => number = Date.now,
): (fresh?: boolean) => Promise<boolean> {
  let answer: { at: number; ok: boolean } | null = null;

  return async function isDatabaseReachable(fresh = false): Promise<boolean> {
    if (!fresh && answer) {
      const stillGoodFor = answer.ok ? REMEMBER_GOOD_MS : REMEMBER_BAD_MS;
      if (now() - answer.at < stillGoodFor) return answer.ok;
    }
    const ok = await askTheDatabase();
    answer = { at: now(), ok };
    return ok;
  };
}
