/**
 * Turning tokens into rupees.
 *
 * `ipy_ai_log` counted input and output tokens from the day it was built and
 * never turned them into money. For a business running on a near-zero AI budget
 * that is the one number that matters, and "1.2 million tokens" is not it.
 *
 * The rounding is the part worth testing. Money in a floating-point column is
 * how a total comes out as ₹0.30000000000000004, and summing thousands of
 * fractions of a rupee is precisely where that shows up — so this stays an
 * integer number of paise from the calculation all the way to the database.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const MODELS: Record<string, unknown[]> = {
  text: [
    { id: 'xiaomi/mimo-v2.5', pricing: { prompt: '0.000000119', completion: '0.000000238' } },
    { id: 'free/model:free', pricing: { prompt: '0', completion: '0' } },
  ],
  speech: [{ id: 'fish-audio/s2.1-pro-free:free', pricing: {} }],
};

async function pricer() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const modality = new URL(String(url)).searchParams.get('output_modalities') ?? '';
    return new Response(JSON.stringify({ data: MODELS[modality] ?? [] }), { status: 200 });
  }));
  const mod = await import('../../src/ai/modelCatalogue.js');
  mod.invalidateModelPrices();
  return mod.costInPaise;
}

describe('what a call cost', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('prices a real call in whole paise', async () => {
    const costInPaise = await pricer();

    // 10,000 in + 2,000 out on mimo:
    //   10000 * 0.000000119 + 2000 * 0.000000238 = 0.001666 dollars
    //   * 88 = ₹0.1466 = 14.66 paise -> 15
    expect(await costInPaise('xiaomi/mimo-v2.5', 10_000, 2_000)).toBe(15);
  });

  it('always returns an integer, however small the call', async () => {
    const costInPaise = await pricer();

    for (const tokens of [1, 7, 33, 101, 999]) {
      const paise = await costInPaise('xiaomi/mimo-v2.5', tokens, tokens);
      expect(Number.isInteger(paise), `${tokens} tokens gave ${paise}`).toBe(true);
      expect(paise).toBeGreaterThanOrEqual(0);
    }
  });

  it('costs nothing for a free model', async () => {
    const costInPaise = await pricer();
    expect(await costInPaise('free/model:free', 50_000, 50_000)).toBe(0);
  });

  it('prices a model it has never heard of at zero rather than guessing', async () => {
    /*
      Deliberate. Showing ₹0 for something uncounted is a smaller lie than
      inventing a number, and the call count sitting beside it in the table is
      what makes the gap visible.
    */
    const costInPaise = await pricer();
    expect(await costInPaise('nobody/has-this-model', 10_000, 10_000)).toBe(0);
  });

  it('costs nothing when there were no tokens', async () => {
    // Media calls report no token counts at all.
    const costInPaise = await pricer();
    expect(await costInPaise('xiaomi/mimo-v2.5', 0, 0)).toBe(0);
  });

  it('looks beyond the chat models, which is where this would silently break', async () => {
    /*
      The plain /models list is chat-only. Pricing from it alone would value
      every voiceover, embedding and reranking call at zero and quietly report
      a free month.
    */
    const costInPaise = await pricer();
    await costInPaise('xiaomi/mimo-v2.5', 1, 1);

    const asked = (globalThis.fetch as unknown as { mock: { calls: [string][] } }).mock.calls
      .map(([url]) => new URL(String(url)).searchParams.get('output_modalities'));

    for (const modality of ['text', 'embeddings', 'rerank', 'speech', 'audio', 'video', 'transcription']) {
      expect(asked, `${modality} models must be priced too`).toContain(modality);
    }
  });

  it('asks the catalogue once, not on every call', async () => {
    // This runs on every single AI call. A price lookup that makes an HTTP
    // request is a price lookup somebody deletes.
    const costInPaise = await pricer();
    await costInPaise('xiaomi/mimo-v2.5', 100, 100);
    const afterFirst = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

    await costInPaise('xiaomi/mimo-v2.5', 100, 100);
    await costInPaise('free/model:free', 100, 100);

    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(afterFirst);
  });

  it('costs nothing rather than throwing when the catalogue is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const mod = await import('../../src/ai/modelCatalogue.js');
    mod.invalidateModelPrices();

    // An AI call must not fail because a price list was unavailable.
    await expect(mod.costInPaise('xiaomi/mimo-v2.5', 100, 100)).resolves.toBe(0);
  });
});
