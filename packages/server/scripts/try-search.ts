/**
 * Run the real global search, as a real person, and say how long it took and
 * whether it threw. Prints counts, timings and error text only — never a
 * record's contents. Reads only: globalSearch writes nothing.
 *
 * Why this exists: the search box swallows every error and shows "No matches",
 * so a failing search and an empty one look the same from the screen.
 */
import { db } from '../src/db/pool.js';
import { loadUser } from '../src/middleware/auth.js';
import { buildScopeContext } from '../src/core/permissions/index.js';
import { recordService } from '../src/core/entity/recordService.js';

const terms = ['rishabh', '9891222206', 'sharma', 'vikram chahar', '2 bhk, greenfields'];

async function main(): Promise<void> {
  const who = await db.queryOne<{ id: string }>(
    `SELECT id FROM ipy_user WHERE is_active = true AND deleted_at IS NULL
      ORDER BY last_login_at DESC NULLS LAST LIMIT 1`,
  );
  if (!who) throw new Error('no active user');
  const user = await loadUser(who.id);
  if (!user) throw new Error('could not load that user');
  const scope = await buildScopeContext(user);
  for (const term of terms) {
    const started = Date.now();
    try {
      const hits = await recordService.globalSearch(scope, term, 20);
      console.log(`OK    ${String(Date.now() - started).padStart(6)} ms  ${hits.length} hits  for a ${term.length}-character search`);
    } catch (error) {
      console.log(`FAIL  ${String(Date.now() - started).padStart(6)} ms  ${(error as Error).message}`);
    }
  }
  process.exit(0);
}

void main().catch((error) => { console.log('could not start:', (error as Error).message); process.exit(1); });
