/**
 * A daily allowance is not spent three times and then asked for again.
 *
 * On 15 September 2026 the embedding job had made 4,866 attempts in thirty
 * days against a free tier that allows fifty a day, and 4,318 of them came
 * back "Rate limit exceeded: free-models-per-day". Each of those was then
 * retried twice more on an 800ms backoff, into the same ceiling. The search
 * index stopped filling and the admin page showed a wall of failures with no
 * hint that the cause was a cap rather than a broken model.
 *
 * These pin the two halves of the fix: stop retrying a ceiling, and stop
 * calling a model whose day is spent until the provider says it is back.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const PER_DAY = JSON.stringify({
  error: {
    message: 'Rate limit exceeded: free-models-per-day. Add 5 credits to unlock 1000 free model requests per day',
    code: 429,
    metadata: { headers: { 'X-RateLimit-Limit': '50', 'X-RateLimit-Remaining': '0' } },
  },
});

/** A cap that lifts in a minute, not a day — the per-minute limiter. */
const PER_MINUTE = JSON.stringify({
  error: { message: 'Rate limit exceeded: free-models-per-min. ', code: 429 },
});

describe('a model that has used up its day', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function loadWith(fetchImpl: typeof fetch) {
    vi.stubGlobal('fetch', fetchImpl);
    vi.doMock('../../src/core/settings/integrations.js', () => ({
      getAiProviderSettings: () => ({ apiKey: 'test-key', baseUrl: 'https://openrouter.ai/api/v1' }),
      getSttProviderSettings: () => ({ apiKey: '', baseUrl: '', model: '' }),
    }));
    vi.doMock('../../src/db/pool.js', () => ({
      db: { query: async () => ({ rows: [], rowCount: 0 }), queryOne: async () => null },
    }));
    return import('../../src/ai/media.js');
  }

  it('does not retry into the same ceiling', async () => {
    const fetchImpl = vi.fn(async () => new Response(PER_DAY, { status: 429 })) as unknown as typeof fetch;
    const { embed } = await loadWith(fetchImpl);

    expect(await embed(['a lead'], { model: 'spent/model' })).toBeNull();
    // One attempt, not the three a 429 normally earns: the allowance is gone
    // for the day, so the other two could only spend what is left of it.
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1);
  });

  it('stops calling that model at all until the day turns', async () => {
    const fetchImpl = vi.fn(async () => new Response(PER_DAY, { status: 429 })) as unknown as typeof fetch;
    const { embed } = await loadWith(fetchImpl);

    await embed(['first'], { model: 'spent/model' });
    const afterFirst = vi.mocked(fetchImpl).mock.calls.length;

    let said = '';
    expect(await embed(['second'], { model: 'spent/model', onError: (m) => { said = m; } })).toBeNull();

    // Nothing left the machine the second time.
    expect(vi.mocked(fetchImpl).mock.calls.length).toBe(afterFirst);
    // And the caller is told why, in words an admin can act on.
    expect(said).toContain('allowance');
    expect(said).toContain('openrouter.ai');
  });

  it('holds the spent model and no other', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => (
      String(init?.body).includes('spent/model')
        ? new Response(PER_DAY, { status: 429 })
        : new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2], index: 0 }] }), { status: 200 })
    )) as unknown as typeof fetch;
    const { embed } = await loadWith(fetchImpl);

    await embed(['x'], { model: 'spent/model' });
    // A different model on the same account has its own allowance.
    expect(await embed(['y'], { model: 'fresh/model' })).toEqual([[0.1, 0.2]]);
  });

  it('still retries a per-minute limit, which really does pass', async () => {
    const fetchImpl = vi.fn(async () => new Response(PER_MINUTE, { status: 429 })) as unknown as typeof fetch;
    const { embed } = await loadWith(fetchImpl);

    await embed(['a lead'], { model: 'busy/model' });
    // Three attempts, as before: a minute's limit lifts while the backoff runs.
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(3);
  });
});
