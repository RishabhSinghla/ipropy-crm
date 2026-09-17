/**
 * A backfill must reach the records that have never been indexed.
 *
 * The candidate query took the thirty-two most recently *updated* records
 * needing work. That is the shape this codebase has now been bitten by five
 * times — a bounded slice ordered by something unrelated to the decision being
 * made — and here it meant the backlog was permanently last in the queue: a
 * record nobody has touched for months is exactly the one missing from the
 * index, and every nudge from a workflow or a rep jumped ahead of it with text
 * that had not changed, so the batch embedded nothing and asked again.
 *
 * Measured on production on 17 September 2026: 27,376 rows for 47 minutes with
 * no growth, 17,061 records still unembedded, and a database kept awake going
 * nowhere — which is where the bill was going.
 *
 * This pins the ordering itself rather than the behaviour, because the bug was
 * one clause and the cost of it was invisible from every screen.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('../../src/core/search/semantic.ts', import.meta.url)),
  'utf8',
);

describe('the embedding backlog', () => {
  it('serves never-embedded records before merely stale ones', () => {
    expect(source).toContain('ORDER BY (e.id IS NULL) DESC, r.updated_at DESC');
  });

  it('never orders the candidate slice by recency alone again', () => {
    // The exact clause that stalled the rebuild. If it comes back, so does a
    // rebuild that runs for ever and a database that never powers down.
    const recencyOnly = /ORDER BY\s+r\.updated_at DESC\s*\n\s*LIMIT/;
    expect(recencyOnly.test(source)).toBe(false);
  });

  it('still keeps a cap on the slice, so one visit cannot run away', () => {
    expect(source).toContain('LIMIT $1');
  });
});
