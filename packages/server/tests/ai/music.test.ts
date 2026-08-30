/**
 * Asking a music model for music.
 *
 * The request used to carry `modalities: ['audio']` and `audio: { format }`,
 * which are not parameters these models accept — OpenRouter publishes exactly
 * what each one takes, and Lyria's are `max_tokens, response_format, seed,
 * temperature, top_p`. An unsupported parameter is rejected outright, which
 * matches how it failed: 0.0 seconds, far too fast for anything to have tried to
 * generate five seconds of audio.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

async function musicWith(respond: () => Response): Promise<{ result: Buffer | null; sent: Record<string, unknown> }> {
  let sent: Record<string, unknown> = {};
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    return respond();
  }));
  vi.doMock('../../src/core/settings/integrations.js', () => ({
    getAiProviderSettings: () => ({ apiKey: 'test-key', baseUrl: 'https://openrouter.ai/api/v1' }),
    getSttProviderSettings: () => ({ apiKey: '', baseUrl: '', model: '' }),
  }));
  vi.doMock('../../src/core/settings/aiModels.js', () => ({
    modelFor: async () => 'google/lyria-3-clip-preview',
  }));
  vi.doMock('../../src/db/pool.js', () => ({
    db: { query: async () => ({ rows: [], rowCount: 0 }), queryOne: async () => null },
  }));
  const { music } = await import('../../src/ai/media.js');
  const result = await music('A calm piano phrase.', { seconds: 5 });
  return { result, sent };
}

const MP3 = Buffer.from('fake mp3').toString('base64');

describe('generating a music bed', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('sends only parameters the model accepts', async () => {
    const { sent } = await musicWith(() => new Response(
      JSON.stringify({ choices: [{ message: { audio: { data: MP3 } } }] }), { status: 200 },
    ));

    expect(sent.model).toBe('google/lyria-3-clip-preview');
    expect(sent.messages).toBeTruthy();
    // The two that were getting the whole request refused.
    expect(sent).not.toHaveProperty('modalities');
    expect(sent).not.toHaveProperty('audio');
  });

  it('reads base64 audio in the OpenAI shape', async () => {
    const { result } = await musicWith(() => new Response(
      JSON.stringify({ choices: [{ message: { audio: { data: MP3 } } }] }), { status: 200 },
    ));
    expect(result?.toString()).toBe('fake mp3');
  });

  it.each([
    ['audio.url', { audio: { url: `data:audio/mpeg;base64,${MP3}` } }],
    ['content', { content: `data:audio/mp3;base64,${MP3}` }],
    ['images', { images: [{ image_url: { url: `data:audio/wav;base64,${MP3}` } }] }],
  ])('reads audio handed back as a data URL under %s', async (_where, message) => {
    // Providers disagree about where an attachment goes, and a reader that knows
    // one shape reports "no audio came back" for a response that had audio in it.
    const { result } = await musicWith(() => new Response(
      JSON.stringify({ choices: [{ message }] }), { status: 200 },
    ));
    expect(result?.toString()).toBe('fake mp3');
  });

  it('says the model answered without audio, rather than blaming the id', async () => {
    const said: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'Here is a calm piano piece.' } }] }), { status: 200 },
    )));
    vi.doMock('../../src/core/settings/integrations.js', () => ({
      getAiProviderSettings: () => ({ apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1' }),
      getSttProviderSettings: () => ({ apiKey: '', baseUrl: '', model: '' }),
    }));
    vi.doMock('../../src/core/settings/aiModels.js', () => ({ modelFor: async () => 'some/chat-model' }));
    vi.doMock('../../src/db/pool.js', () => ({
      db: { query: async () => ({ rows: [], rowCount: 0 }), queryOne: async () => null },
    }));
    const { music } = await import('../../src/ai/media.js');

    const result = await music('A calm piano phrase.', { onError: (m) => said.push(m) });
    expect(result).toBeNull();
    expect(said.join(' ')).toContain('no audio attached');
  });
});
