/**
 * A computed field refuses an edit instead of pretending to take it.
 *
 * `rating` is the Hot/Warm/Cold band the scorer writes. It was writable, and
 * the result was the worst of every option: the API answered 200, the audit
 * trail recorded the change as having happened, and the value was overwritten
 * moments later. The rep saw Hot, the database kept Warm, and nothing anywhere
 * said so.
 *
 * Two separate faults had to line up for that:
 *
 *  * **The fields were not marked read-only.** The seed re-upserts field
 *    structure on every cold start, which is what undid the readonly flag
 *    until the flags moved into the seed template itself.
 *  * **Read-only was not enforced on writes.** `filterWritableFields` began
 *    `if (user.isAdmin) return values`, which is right for a profile permission
 *    — an admin overriding who may edit a budget is the point of being an admin
 *    — and wrong for a computed field. Typing into a derived value does not
 *    become allowed because you are an admin; it becomes silently discarded.
 *
 * System writes are deliberately unaffected: `updateRecord` skips this path
 * entirely when `ctx.system` is set, which is how the scorer writes `rating`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { registry } from '../../src/core/metadata/registry.js';
import { adminContext } from './fixtures.js';

let recordId: string;
let ctx: Awaited<ReturnType<typeof adminContext>>;

beforeAll(async () => {
  await registry.warmup();
  ctx = await adminContext();
  const lead = await recordService.createRecord(ctx, 'leads', {
    full_name: `Derived Fields ${Date.now()}`,
    mobile: '9811500888',
    status: 'New',
  });
  recordId = lead.id;
});

afterAll(async () => {
  if (recordId) await db.query(`DELETE FROM ipy_record WHERE id = $1`, [recordId]);
});

describe('fields that are computed', () => {
  it.each(['rating'])('marks %s read-only in the metadata', async (name) => {
    const module = await registry.requireModule('leads');
    const field = module.fields.find((f) => f.name === name);
    expect(field?.isReadonly, `${name} is derived and must be declared read-only`).toBe(true);
  });

  it('does not let an admin type a rating', async () => {
    await db.query(`UPDATE ipy_e_leads SET rating = 'Warm' WHERE record_id = $1`, [recordId]);

    await recordService.updateRecord(ctx, 'leads', recordId, { rating: 'Hot' });

    const row = await db.queryOne<{ rating: string }>(
      `SELECT rating FROM ipy_e_leads WHERE record_id = $1`, [recordId],
    );
    expect(row?.rating).toBe('Warm');
  });

  it('still saves an ordinary field in the same call', async () => {
    // The guard must drop the computed key and keep the rest, not refuse the
    // whole save — a rep editing four fields should not lose three of them.
    await recordService.updateRecord(ctx, 'leads', recordId, {
      company: 'Still Saves Ltd',
      rating: 'Hot',
    });

    const row = await db.queryOne<{ company: string; rating: string }>(
      `SELECT company, rating FROM ipy_e_leads WHERE record_id = $1`, [recordId],
    );
    expect(row?.company).toBe('Still Saves Ltd');
    // rating stays whatever the scorer last wrote: the computed one is dropped,
    // not the whole save.
    expect(row?.rating).toBe('Warm');
  });

  it('still lets the system write it, or scoring stops working', async () => {
    // The scorer writes rating on every score. If this path were closed to it
    // too, the fix would break the feature it exists to protect.
    await recordService.updateRecord(
      { ...ctx, system: true }, 'leads', recordId, { rating: 'Cold' },
    );

    const row = await db.queryOne<{ rating: string }>(
      `SELECT rating FROM ipy_e_leads WHERE record_id = $1`, [recordId],
    );
    expect(row?.rating, 'a system write must still reach a computed field').toBe('Cold');
  });
});
