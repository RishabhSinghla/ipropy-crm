/**
 * Transcription goes to the speech-to-text provider, as multipart.
 *
 * It used to go to OpenRouter with every other media call, and was wrong twice
 * over: OpenRouter is a chat gateway and does not transcribe, and the body was
 * JSON with the audio base64-encoded when every OpenAI-compatible transcription
 * endpoint takes multipart form data with a file part. So the settings box said
 * "it could not read the audio" whatever id was in it, and no id would ever have
 * fixed it.
 *
 * These assert the two things that were wrong — where it goes, and what shape it
 * is in — because a mock that only checks the return value would have passed
 * against the broken version too.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const AUDIO = Buffer.from('fake wav bytes');

interface Caught { url: string; init: RequestInit }

async function transcribeWith(
  settings: { apiKey: string; baseUrl: string; model: string },
  respond: () => Response,
): Promise<{ result: unknown; calls: Caught[] }> {
  const calls: Caught[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond();
  }));
  vi.doMock('../../src/core/settings/integrations.js', () => ({
    getSttProviderSettings: () => settings,
    getAiProviderSettings: () => ({ apiKey: '', baseUrl: '' }),
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

  it('sends it to the speech-to-text provider, not to OpenRouter', async () => {
    const { calls } = await transcribeWith(GROQ, () => new Response('{"text":"hello"}', { status: 200 }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(calls[0]!.url).not.toContain('openrouter');
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

  it('says which screen to go to when no key is saved', async () => {
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
