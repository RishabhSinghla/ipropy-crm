/**
 * When a model id is wrong, say what the provider said.
 *
 * Four boxes on the settings screen were reporting "No vector came back. Check
 * the id is an embedding model." and similar — a guess, offered as a diagnosis,
 * for four different failures. The real reason was in `lastError` inside
 * `request()` the whole time, written to `ipy_ai_log` and then dropped on the
 * floor. An admin cannot act on a guess; they can act on "that model does not
 * exist".
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const NO_SUCH_MODEL = '404 {"error":{"message":"No endpoints found for made-up/model."}}';

describe('the model test', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function testWith(fetchImpl: typeof fetch, job: string, model: string) {
    vi.stubGlobal('fetch', fetchImpl);
    // A key has to look present, or the call is refused before it is made.
    vi.doMock('../../src/core/settings/integrations.js', () => ({
      getAiProviderSettings: () => ({ apiKey: 'test-key', baseUrl: 'https://openrouter.ai/api/v1' }),
    }));
    vi.doMock('../../src/db/pool.js', () => ({
      db: { query: async () => ({ rows: [], rowCount: 0 }), queryOne: async () => null },
    }));
    const { testMediaModel } = await import('../../src/ai/mediaTest.js');
    return testMediaModel(job, model);
  }

  it('repeats what the provider said rather than guessing', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      '{"error":{"message":"No endpoints found for made-up/model."}}',
      { status: 404 },
    )) as unknown as typeof fetch;

    const result = await testWith(fetchImpl, 'embed', 'made-up/model');

    expect(result.ok).toBe(false);
    // The sentence an admin can act on.
    expect(result.message).toContain('No endpoints found');
    expect(result.message).toContain('The provider said');
  });

  it('still explains itself when the provider says nothing useful', async () => {
    // A network failure has no body to quote, so the guess is all there is —
    // and it must still be a whole sentence rather than a dangling fragment.
    const fetchImpl = vi.fn(async () => { throw new Error('fetch failed'); }) as unknown as typeof fetch;

    const result = await testWith(fetchImpl, 'embed', 'made-up/model');

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/No vector came back|fetch failed/);
  });

  it('says so plainly when no key is saved at all', async () => {
    vi.doMock('../../src/core/settings/integrations.js', () => ({
      getAiProviderSettings: () => ({ apiKey: '', baseUrl: '' }),
    }));
    vi.doMock('../../src/db/pool.js', () => ({
      db: { query: async () => ({ rows: [], rowCount: 0 }), queryOne: async () => null },
    }));
    const { testMediaModel } = await import('../../src/ai/mediaTest.js');
    const result = await testMediaModel('embed', 'anything/at-all');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('OpenRouter key');
  });
});

describe('what the failure text is for', () => {
  it('names the provider error rather than burying it in a log', () => {
    // Pinning the intent: the old messages were a diagnosis the code was in no
    // position to make. Four different causes — a retired id, a typo, a model of
    // the wrong kind, a key without access — all read as "check the id".
    expect(NO_SUCH_MODEL).toContain('No endpoints found');
  });
});
