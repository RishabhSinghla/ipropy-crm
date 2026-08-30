/**
 * Transcription, as multipart, to whichever provider has a key.
 *
 * One thing was wrong with the original, not two. The body was JSON with the
 * audio base64-encoded, where every OpenAI-compatible transcription endpoint
 * takes multipart form data with a file part. That alone is why the settings box
 * said "it could not read the audio" whatever id was in it.
 *
 * The host was **not** wrong, though it was written off as one here. OpenRouter
 * does transcribe: nineteen models at `/audio/transcriptions`, taking this exact
 * shape. The mistake was checking the shipped ASR id against `/api/v1/models`,
 * which is chat-only, finding nothing, and concluding it was invented.
 *
 * So both providers work and the key decides. These pin the shape, which was the
 * real defect, and the choice between providers — a mock that only checked the
 * return value would have passed against the broken version too.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const AUDIO = Buffer.from('fake wav bytes');

interface Caught { url: string; init: RequestInit }

async function transcribeWith(
  settings: { apiKey: string; baseUrl: string; model: string },
  respond: () => Response,
  openRouter: { apiKey: string; baseUrl: string } = { apiKey: '', baseUrl: '' },
): Promise<{ result: unknown; calls: Caught[] }> {
  const calls: Caught[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond();
  }));
  vi.doMock('../../src/core/settings/integrations.js', () => ({
    getSttProviderSettings: () => settings,
    getAiProviderSettings: () => openRouter,
  }));
  vi.doMock('../../src/core/settings/aiModels.js', () => ({
    modelFor: async () => settings.model,
  }));
  vi.doMock('../../src/db/pool.js', () => ({
    db: { query: async () => ({ rows: [], rowCount: 0 }), queryOne: async () => null },
  }));
  const { transcribe } = await import('../../src/ai/media.js');
  const result = await transcribe(AUDIO, 'wav');
  return { result, calls };
}

const GROQ = {
  apiKey: 'gsk-test',
  baseUrl: 'https://api.groq.com/openai/v1',
  model: 'whisper-large-v3-turbo',
};

describe('transcribing a recording', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('prefers the speech-to-text card when it has a key', async () => {
    // Somebody who filled that card in meant it, so it outranks the fallback.
    const { calls } = await transcribeWith(
      GROQ,
      () => new Response('{"text":"hello"}', { status: 200 }),
      { apiKey: 'or-key', baseUrl: 'https://openrouter.ai/api/v1' },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
  });

  it('falls back to OpenRouter when no speech-to-text key is saved', async () => {
    /*
      OpenRouter serves nineteen transcription models at this path, so a CRM
      with an OpenRouter key already has working transcription and needs no
      second signup. This whole path was removed once on the false belief that
      OpenRouter cannot transcribe.
    */
    const { calls, result } = await transcribeWith(
      { apiKey: '', baseUrl: '', model: '' },
      () => new Response('{"text":"do bedroom chahiye"}', { status: 200 }),
      { apiKey: 'or-key', baseUrl: 'https://openrouter.ai/api/v1' },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer or-key');
    // Same multipart shape either way, which is why one code path serves both.
    expect(calls[0]!.init.body).toBeInstanceOf(FormData);
    expect(result).toMatchObject({ text: 'do bedroom chahiye' });
  });

  it('sends multipart with a file, which is what the endpoint accepts', async () => {
    const { calls } = await transcribeWith(GROQ, () => new Response('{"text":"hello"}', { status: 200 }));

    const body = calls[0]!.init.body;
    expect(body, 'the body must be form data, not JSON').toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(form.get('model')).toBe('whisper-large-v3-turbo');
    expect(form.get('file'), 'the audio goes as a file part').toBeInstanceOf(Blob);

    // Setting Content-Type by hand omits the multipart boundary and the request
    // is refused as malformed, so it must be left to fetch.
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('content-type');
    expect(headers.Authorization).toBe('Bearer gsk-test');
  });

  it('returns the words it got back', async () => {
    const { result } = await transcribeWith(
      GROQ,
      () => new Response('{"text":"  do bedroom chahiye  "}', { status: 200 }),
    );
    expect(result).toMatchObject({ text: 'do bedroom chahiye', model: 'whisper-large-v3-turbo' });
  });

  it('treats silence as an answer rather than a failure', async () => {
    // A recording with nothing said in it transcribes to an empty string. That
    // is a successful transcription of silence, and the caller decides what it
    // means; returning null made it indistinguishable from a broken call.
    const { result } = await transcribeWith(GROQ, () => new Response('{"text":""}', { status: 200 }));
    expect(result).toMatchObject({ text: '' });
  });

  it('reports what the provider said when it refuses', async () => {
    const said: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '{"error":{"message":"model_not_found"}}', { status: 404 },
    )));
    vi.doMock('../../src/core/settings/integrations.js', () => ({
      getSttProviderSettings: () => GROQ,
      getAiProviderSettings: () => ({ apiKey: '', baseUrl: '' }),
    }));
    vi.doMock('../../src/core/settings/aiModels.js', () => ({ modelFor: async () => GROQ.model }));
    vi.doMock('../../src/db/pool.js', () => ({
      db: { query: async () => ({ rows: [], rowCount: 0 }), queryOne: async () => null },
    }));
    const { transcribe } = await import('../../src/ai/media.js');

    const result = await transcribe(AUDIO, 'wav', { onError: (m) => said.push(m) });
    expect(result).toBeNull();
    expect(said.join(' ')).toContain('model_not_found');
  });

  it('says which screen to go to when neither provider has a key', async () => {
    const said: string[] = [];
    const { result } = await (async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
      vi.doMock('../../src/core/settings/integrations.js', () => ({
        getSttProviderSettings: () => ({ apiKey: '', baseUrl: '', model: '' }),
        getAiProviderSettings: () => ({ apiKey: '', baseUrl: '' }),
      }));
      vi.doMock('../../src/core/settings/aiModels.js', () => ({ modelFor: async () => 'whisper-large-v3-turbo' }));
      vi.doMock('../../src/db/pool.js', () => ({
        db: { query: async () => ({ rows: [], rowCount: 0 }), queryOne: async () => null },
      }));
      const { transcribe } = await import('../../src/ai/media.js');
      return { result: await transcribe(AUDIO, 'wav', { onError: (m) => said.push(m) }) };
    })();

    expect(result).toBeNull();
    expect(said.join(' ')).toContain('Admin → Integrations');
  });
});
