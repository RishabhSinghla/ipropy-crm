/**
 * Scoring a lead actually writes the score.
 *
 * It stopped. Removing the AI grade took `ai_grade = $3` out of the UPDATE and
 * renumbered the parameters after it — except one, which stayed at `$5` while
 * only four values were bound. Postgres refuses the whole statement for that
 * with 42P18, "could not determine data type of parameter $4".
 *
 * Every lead scored since failed, and nothing showed it. The write happens
 * inside a workflow task that logs the error and carries on with the rest, so
 * the CRM looked fine and scores simply stopped moving. It surfaced only because
 * a browser test printed the server log.
 *
 * CLAUDE.md rule 8 exists for this and says the codebase had been bitten three
 * times. That was the fourth. Nothing but a real database catches it: the SQL is
 * a string, so typecheck sees nothing, and a mocked `db.query` accepts any
 * parameter list at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { scoreLead } from '../../src/ai/leadScoring.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { adminContext } from './fixtures.js';

let recordId: string;

beforeAll(async () => {
  const ctx = await adminContext();
  const lead = await recordService.createRecord(ctx, 'leads', {
    full_name: `Scoring Persists ${Date.now()}`,
    mobile: '9811500001',
    status: 'New',
  });
  recordId = lead.id;
});

afterAll(async () => {
  if (recordId) await db.query(`DELETE FROM ipy_record WHERE id = $1`, [recordId]);
});

describe('persisting a lead score', () => {
  it('writes the rating', async () => {
    const result = await scoreLead(recordId);
    expect(result, 'scoring should produce a result').toBeTruthy();

    const row = await db.queryOne<{ rating: string | null }>(
      `SELECT rating FROM ipy_e_leads WHERE record_id = $1`,
      [recordId],
    );

    // The assertion that would have caught the parameter bug: the write must
    // have RUN. The 0-100 score is retired (migration 104); the temperature
    // is what persists now.
    expect(row?.rating, 'the rating is the parameter that was misnumbered').toBeTruthy();
    expect(['Hot', 'Warm', 'Cold']).toContain(row?.rating);
  });

  it('does not throw when it runs, which is how this hid', async () => {
    /*
      The failure was swallowed by the workflow task that calls this, so the
      only way to see it was to look at a log. Asserting the promise resolves is
      not enough on its own — hence the row check above — but a rejection here
      would mean it is broken in a louder way than last time.
    */
    await expect(scoreLead(recordId)).resolves.toBeTruthy();
  });

  it('binds exactly the parameters its statement references', async () => {
    /*
      The shape of the bug, pinned directly. A gap in the numbering is not
      ignored by Postgres — `$1, $2, $3, $5` with four values bound is a hard
      error on the whole statement, and it reads as a type problem rather than a
      counting one, which is what makes it slow to diagnose.
    */
    const source = await (await import('node:fs/promises'))
      .readFile(new URL('../../src/ai/leadScoring.ts', import.meta.url), 'utf8');

    const statement = source.slice(source.indexOf('UPDATE ipy_e_leads'), source.indexOf('WHERE record_id = $1') + 24);
    const used = [...statement.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    const highest = Math.max(...used);

    // Every number from 1 to the highest must actually appear.
    for (let n = 1; n <= highest; n += 1) {
      expect(used, `$${n} is skipped, which Postgres refuses`).toContain(n);
    }
  });
});
