/**
 * Search by meaning with real-sized (1,024-number) vectors, the size that has an
 * index (migration 212).
 *
 * `semanticSearch.test.ts` uses eight-number vectors on purpose, so its answers
 * can be reasoned about. Those never reach the index path, which only applies at
 * 1,024. These tests are the ones that do, and what they pin is the same promise
 * as before: the faster route must never show somebody a record they may not see,
 * and a person who may see very little must still be answered.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

const AXES = ['terrace', 'parking', 'diwali', 'possession', 'loan', 'north', 'kitchen', 'balcony'];
const SIZE = 1024;

function fakeVector(text: string): number[] {
  const lower = text.toLowerCase();
  // Eight meaningful numbers, the other 1,016 a small floor, then normalised.
  const raw = Array.from({ length: SIZE }, (_, i) => (i < AXES.length && lower.includes(AXES[i]!) ? 1 : 0) + 0.01);
  const length = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0));
  return raw.map((v) => v / length);
}

vi.mock('../../src/ai/media.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/ai/media.js')>('../../src/ai/media.js');
  return {
    ...actual,
    isMediaAiAvailable: () => true,
    embed: async (texts: string[]) => texts.map((t) => fakeVector(t)),
    rerank: async (_q: string, documents: string[], opts?: { topN?: number }) =>
      documents.map((_d, index) => ({ index, score: 1 - index / 100 })).slice(0, opts?.topN ?? documents.length),
  };
});

const { createRecord } = await import('../../src/core/entity/recordService.js');
const { indexPending, search } = await import('../../src/core/search/semantic.js');
const { db } = await import('../../src/db/pool.js');
const { adminContext, contextFor, leadInput, SEEDED } = await import('./fixtures.js');

type Ctx = Awaited<ReturnType<typeof adminContext>>;
let admin: Ctx;
let executiveA: Ctx;
let executiveB: Ctx;
const unique = (): string => Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

async function makeLead(owner: Ctx, searchText: string): Promise<string> {
  const record = await createRecord(owner, 'leads', leadInput({ full_name: `Index ${unique()}`, company: searchText }));
  await db.query(`UPDATE ipy_record SET search_text = $2 WHERE id = $1`, [record.id, searchText]);
  return record.id;
}

beforeAll(async () => {
  admin = await adminContext();
  executiveA = await contextFor(SEEDED.executiveA);
  executiveB = await contextFor(SEEDED.executiveB);
});

describe('search through the index', () => {
  it('has the index, because migration 212 builds it on a small table', async () => {
    const row = await db.queryOne<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_embedding_nearest_1024'`,
    );
    expect(row?.indexdef).toMatch(/hnsw/);
  });

  it('finds the closest record at the indexed size', async () => {
    const id = await makeLead(admin, 'possession diwali');
    await indexPending(200);
    const stored = await db.queryOne<{ dims: number }>(
      `SELECT dims FROM ipy_embedding WHERE kind = 'record' AND source_id = $1`, [id],
    );
    expect(stored?.dims).toBe(SIZE);

    const hits = await search('possession diwali', admin, { top: 10 });
    expect(hits[0]?.recordId).toBe(id);
  });

  it('never returns a record the asker cannot see, however close it is', async () => {
    const theirs = await createRecord(executiveB, 'leads', leadInput({ full_name: `Private ${unique()}` }));
    await db.query(`UPDATE ipy_record SET search_text = $2 WHERE id = $1`, [theirs.id, 'terrace parking']);
    await indexPending(200);

    const asAdmin = await search('terrace parking', admin, { top: 20 });
    expect(asAdmin[0]?.recordId).toBe(theirs.id);

    const asStranger = await search('terrace parking', executiveA, { top: 20 });
    expect(asStranger.map((h) => h.recordId)).not.toContain(theirs.id);
  });

  it('still answers somebody who may see very little', async () => {
    // A record of their own among crowds of other people's: the fast route's
    // nearest few hundred may hold hardly any of theirs, so this must fall back
    // to the exact way rather than come back empty.
    const mine = await makeLead(executiveA, 'loan kitchen north');
    for (let i = 0; i < 3; i += 1) await makeLead(executiveB, 'loan kitchen north');
    await indexPending(200);

    const hits = await search('loan kitchen north', executiveA, { top: 10 });
    expect(hits.map((h) => h.recordId)).toContain(mine);
  });
});
