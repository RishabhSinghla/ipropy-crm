/**
 * "You may already have this person", and the one thing it must never do.
 *
 * The risk is not missing a duplicate. It is asserting one: a father and a son
 * share a surname, a locality and often a budget, and a CRM that keeps insisting
 * they are the same man is one people learn to ignore — which then costs them
 * the real duplicates too.
 *
 * So: it suggests, it never merges, and a dismissal is for ever.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

const AXES = ['rajesh', 'kumar', 'greenfield', 'sector21', 'fourbhk', 'threebhk', 'crore', 'lakh'];

function fakeVector(text: string): number[] {
  const lower = text.toLowerCase().replace(/\s+/g, '');
  const raw = AXES.map((axis) => (lower.includes(axis) ? 1 : 0)).map((v) => v + 0.01);
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
const { indexPending } = await import('../../src/core/search/semantic.js');
const { suggestDuplicates, dismissDuplicate } = await import('../../src/core/search/duplicates.js');
const { db } = await import('../../src/db/pool.js');
const { adminContext, leadInput } = await import('./fixtures.js');

let admin: Awaited<ReturnType<typeof adminContext>>;
const unique = (): string => Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

async function lead(name: string, about: string): Promise<string> {
  const record = await createRecord(admin, 'leads', leadInput({ full_name: name }));
  await db.query(`UPDATE ipy_record SET search_text = $2 WHERE id = $1`, [record.id, about]);
  return record.id;
}

beforeAll(async () => {
  admin = await adminContext();
});

describe('spotting the same person twice', () => {
  it('finds a lead entered again under a shortened name', async () => {
    const tag = unique();
    const first = await lead(`Rajesh Kumar ${tag}`, 'rajesh kumar greenfield fourbhk crore');
    const second = await lead(`R Kumar ${tag}`, 'rajesh kumar greenfield fourbhk crore');
    await indexPending(400);

    const hits = await suggestDuplicates(admin, 'leads', second);
    expect(hits.map((h) => h.recordId)).toContain(first);
  });

  it('never suggests the record itself', async () => {
    const id = await lead(`Solo ${unique()}`, 'rajesh kumar greenfield');
    await indexPending(400);
    const hits = await suggestDuplicates(admin, 'leads', id);
    expect(hits.map((h) => h.recordId)).not.toContain(id);
  });

  it('stops offering a pair once somebody has said they are different', async () => {
    const tag = unique();
    const father = await lead(`Kumar Senior ${tag}`, 'rajesh kumar sector21 threebhk lakh');
    const son = await lead(`Kumar Junior ${tag}`, 'rajesh kumar sector21 threebhk lakh');
    await indexPending(400);

    expect((await suggestDuplicates(admin, 'leads', son)).map((h) => h.recordId)).toContain(father);

    await dismissDuplicate(son, father, admin.user.id);

    expect((await suggestDuplicates(admin, 'leads', son)).map((h) => h.recordId)).not.toContain(father);
    // And from the other side too. Whichever record they happened to be looking
    // at when they said no, the answer holds for the pair.
    expect((await suggestDuplicates(admin, 'leads', father)).map((h) => h.recordId)).not.toContain(son);
  });

  it('says nothing when the feature is switched off', async () => {
    const tag = unique();
    const first = await lead(`Off One ${tag}`, 'rajesh kumar greenfield crore');
    const second = await lead(`Off Two ${tag}`, 'rajesh kumar greenfield crore');
    await indexPending(400);
    expect((await suggestDuplicates(admin, 'leads', second)).map((h) => h.recordId)).toContain(first);

    await db.query(
      `INSERT INTO ipy_setting (key, value, category) VALUES ('ai_features.duplicate_suggestions','false'::jsonb,'ai_features')
       ON CONFLICT (key) DO UPDATE SET value = 'false'::jsonb`,
    );
    const { invalidateAiFeatures } = await import('../../src/core/settings/aiFeatures.js');
    invalidateAiFeatures();

    try {
      expect(await suggestDuplicates(admin, 'leads', second)).toEqual([]);
    } finally {
      await db.query(`UPDATE ipy_setting SET value = 'true'::jsonb WHERE key = 'ai_features.duplicate_suggestions'`);
      invalidateAiFeatures();
    }
  });
});
