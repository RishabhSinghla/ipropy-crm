/**
 * Search by meaning, and the one thing it must never do.
 *
 * The interesting risk here is not relevance, it is leakage. A vector index
 * flattens the whole CRM into one table of text and numbers, and the numbers
 * know nothing about who owns what. If retrieval ranked first and asked about
 * permissions second — or worse, handed the stored text straight to the model —
 * an executive would get answers built out of a colleague's private leads and
 * nothing anywhere would show it.
 *
 * So the tests that matter are the ones where the *most relevant* row is the
 * one the asker may not see.
 *
 * The embedding provider is stubbed. Nothing here is checking that a model
 * understands Hinglish; it is checking the plumbing around it — that unchanged
 * text is not re-embedded, that scope is applied in SQL, and that the answer is
 * built from a record read back rather than from the index.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One dimension per keyword, so "closeness" is something a test can state.
 *
 * A real embedding is a thousand opaque numbers. This is eight, each meaning a
 * word: two texts that share words end up near each other and the assertions
 * can say why, which a random vector could never do.
 */
const AXES = ['terrace', 'parking', 'diwali', 'possession', 'loan', 'north', 'kitchen', 'balcony'];

function fakeVector(text: string): number[] {
  const lower = text.toLowerCase();
  const raw = AXES.map((axis) => (lower.includes(axis) ? 1 : 0));
  // A zero vector has no direction and pgvector's cosine operator returns NaN
  // for it, which sorts unpredictably. Give every text a floor.
  const withFloor = raw.map((v) => v + 0.01);
  const length = Math.sqrt(withFloor.reduce((sum, v) => sum + v * v, 0));
  return withFloor.map((v) => v / length);
}

const embedCalls: string[][] = [];

vi.mock('../../src/ai/media.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/ai/media.js')>('../../src/ai/media.js');
  return {
    ...actual,
    isMediaAiAvailable: () => true,
    embed: async (texts: string[]) => {
      embedCalls.push(texts);
      return texts.map((t) => fakeVector(t));
    },
    // Identity reranking: the point of these tests is the scope, not the order.
    rerank: async (_q: string, documents: string[], opts?: { topN?: number }) =>
      documents.map((_d, index) => ({ index, score: 1 - index / 100 }))
        .slice(0, opts?.topN ?? documents.length),
  };
});

const { createRecord, deleteRecord } = await import('../../src/core/entity/recordService.js');
const { indexPending, search, contextFor: semanticContext } = await import('../../src/core/search/semantic.js');
const { db } = await import('../../src/db/pool.js');
const { adminContext, contextFor, leadInput, SEEDED } = await import('./fixtures.js');

type Ctx = Awaited<ReturnType<typeof adminContext>>;

let admin: Ctx;
let executiveA: Ctx;
let executiveB: Ctx;
const created: string[] = [];

const unique = (): string => Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

async function makeLead(owner: Ctx, note: string): Promise<string> {
  const record = await createRecord(owner, 'leads', leadInput({
    full_name: `Semantic ${unique()}`,
    // The searchable text lives on the record, which is what the record-kind
    // passage embeds.
    company: note,
  }));
  created.push(record.id);
  await db.query(`UPDATE ipy_record SET search_text = $2 WHERE id = $1`, [record.id, note]);
  return record.id;
}

beforeAll(async () => {
  admin = await adminContext();
  executiveA = await contextFor(SEEDED.executiveA);
  executiveB = await contextFor(SEEDED.executiveB);
});

beforeEach(() => {
  embedCalls.length = 0;
});

describe('indexing', () => {
  it('embeds a record once and leaves it alone until its text changes', async () => {
    const id = await makeLead(admin, 'wants a north facing terrace with parking');

    const first = await indexPending(200);
    expect(first.embedded).toBeGreaterThan(0);
    const row = await db.queryOne<{ dims: number; content: string }>(
      `SELECT dims, content FROM ipy_embedding WHERE kind = 'record' AND source_id = $1`, [id],
    );
    expect(row?.dims).toBe(AXES.length);
    expect(row?.content).toContain('terrace');

    // Nothing changed, so nothing should be sent to the provider again. This is
    // the difference between a free tier that lasts and one that is gone by
    // lunchtime.
    embedCalls.length = 0;
    await indexPending(200);
    const resent = embedCalls.flat().filter((t) => t.includes('north facing terrace'));
    expect(resent).toHaveLength(0);
  });

  it('re-embeds when the text actually changes', async () => {
    const id = await makeLead(admin, 'asked about the loan process');
    await indexPending(200);

    await db.query(
      `UPDATE ipy_record SET search_text = $2, updated_at = now() WHERE id = $1`,
      [id, 'now asking about possession before diwali'],
    );
    embedCalls.length = 0;
    await indexPending(200);

    expect(embedCalls.flat().some((t) => t.includes('diwali'))).toBe(true);
    const row = await db.queryOne<{ content: string }>(
      `SELECT content FROM ipy_embedding WHERE kind = 'record' AND source_id = $1`, [id],
    );
    expect(row?.content).toContain('diwali');
  });
});

describe('searching', () => {
  it('finds a record by what it means rather than what it says', async () => {
    const id = await makeLead(admin, 'buyer needs possession before diwali');
    await indexPending(200);

    const hits = await search('possession diwali', admin, { top: 10 });
    expect(hits.map((h) => h.recordId)).toContain(id);
  });

  it('never returns a record the asker cannot see, however close it is', async () => {
    // The single most relevant row in the whole index belongs to somebody else.
    const theirs = await createRecord(executiveB, 'leads', leadInput({
      full_name: `Private ${unique()}`,
    }));
    created.push(theirs.id);
    // Exactly the words of the question and nothing else, so this row is the
    // closest thing in the index by construction. A record that shares *more*
    // words is further away, not nearer: the vectors are normalised, so extra
    // dimensions dilute the ones being asked about.
    await db.query(
      `UPDATE ipy_record SET search_text = $2 WHERE id = $1`,
      [theirs.id, 'terrace parking'],
    );
    await indexPending(200);

    const asAdmin = await search('terrace parking', admin, { top: 20 });
    expect(asAdmin[0]?.recordId).toBe(theirs.id);

    const asStranger = await search('terrace parking', executiveA, { top: 20 });
    expect(asStranger.map((h) => h.recordId)).not.toContain(theirs.id);
  });

  it('builds the assistant context from the record, not from the index', async () => {
    const id = await makeLead(admin, 'kitchen and balcony both facing north');
    await indexPending(200);

    const text = await semanticContext('kitchen balcony', admin, { top: 5 });
    expect(text).toContain(id);
    // The heading comes from the record's own label, which only a read-back
    // produces — the index stores the passage, not the envelope.
    expect(text).toMatch(/### Semantic /);
  });

  it('returns nothing rather than failing when the question is empty', async () => {
    expect(await search('   ', admin)).toEqual([]);
    expect(await semanticContext('', admin)).toBe('');
  });
});

describe('deleting', () => {
  it('takes a deleted record out of the results', async () => {
    const id = await makeLead(admin, 'terrace with a large balcony');
    await indexPending(200);
    expect((await search('terrace balcony', admin, { top: 20 })).map((h) => h.recordId)).toContain(id);

    await deleteRecord(admin, 'leads', id);
    expect((await search('terrace balcony', admin, { top: 20 })).map((h) => h.recordId)).not.toContain(id);
  });
});
