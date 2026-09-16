/**
 * A model id is only meaningful to the provider that serves it.
 *
 * The eight job boxes in Admin → Settings list OpenRouter's catalogue, so
 * `ai_models.vision` holds an OpenRouter id. `complete()` walked its provider
 * chain handing that id to every provider in turn, so Gemini was asked for
 * `xiaomi/mimo-v2.5` and answered "models/xiaomi/mimo-v2.5 is not found",
 * Groq answered "does not exist or you do not have access to it", and only the
 * third hop worked. Reading one document cost two certain failures and about
 * two seconds, and the admin page showed twenty-one vision failures against a
 * model that was working.
 *
 * These pin both halves: the right provider goes first, and the others still
 * get their turn — with their own model, not with an id they have never heard
 * of.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const GEMINI = { provider: 'gemini', apiKey: 'g-key', baseUrl: 'https://gemini.test/v1', model: 'gemini-flash-latest', fastModel: 'gemini-flash-lite-latest', maxTokens: 4096 };
const OPENROUTER = { provider: 'openrouter', apiKey: 'or-key', baseUrl: 'https://openrouter.test/api/v1', model: 'openrouter/free', fastModel: 'openrouter/free', maxTokens: 4096 };

/** Every model the chain actually asked for, in order. */
async function askedModels(opts: Record<string, unknown>, answers: (model: string) => boolean) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const model = String(JSON.parse(String(init?.body)).model);
    asked.push(model);
    return answers(model)
      ? new Response(JSON.stringify({
        model, choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200 })
      : new Response('{"error":{"message":"The model does not exist or you do not have access to it."}}', { status: 404 });
  }));
  vi.doMock('../../src/core/settings/integrations.js', () => ({
    getAiFallbackChain: () => [GEMINI, OPENROUTER],
    getAiProviderSettings: () => null,
    getSettings: () => ({ ai: { enabled: true, model: 'gemini-flash-latest', fastModel: 'gemini-flash-lite-latest' } }),
  }));
  vi.doMock('../../src/db/pool.js', () => ({
    db: { query: async () => ({ rows: [], rowCount: 0 }), queryOne: async () => null },
  }));
  const { complete } = await import('../../src/ai/client.js');
  const result = await complete({ feature: 'document_reading', system: 's', prompt: 'p', ...opts } as never);
  return { asked, result };
}

describe('a model named for a job', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('goes to the provider that serves it, first', async () => {
    const { asked, result } = await askedModels(
      { model: 'xiaomi/mimo-v2.5', provider: 'openrouter' },
      (m) => m === 'xiaomi/mimo-v2.5',
    );
    expect(result).not.toBeNull();
    // One call. Not a 404 from Gemini, then a 404 from Groq, then the answer.
    expect(asked).toEqual(['xiaomi/mimo-v2.5']);
  });

  it('still falls through, but with the other provider’s own model', async () => {
    const { asked, result } = await askedModels(
      { model: 'xiaomi/mimo-v2.5', provider: 'openrouter' },
      (m) => m === 'gemini-flash-latest',
    );
    expect(result).not.toBeNull();
    // OpenRouter got the named id and refused; Gemini was then asked for the
    // model Gemini is configured with, which is the whole point of a fallback.
    expect(asked).toEqual(['xiaomi/mimo-v2.5', 'gemini-flash-latest']);
  });

  it('leaves an unattributed model alone, as the test button needs', async () => {
    // The model-test button names an id with no provider: whoever answers,
    // answers. That behaviour must not change.
    const { asked } = await askedModels({ model: 'some/new-id' }, () => false);
    expect(asked).toEqual(['some/new-id', 'some/new-id']);
  });
});
