/**
 * Asking a music model for music.
 *
 * Two things were wrong, found in that order.
 *
 * The request carried `modalities: ['audio']` and `audio: { format }`, which
 * are real parameters for the OpenAI audio-chat models and are not on Lyria's
 * `supported_parameters`. An unsupported parameter had the whole request
 * refused, which fits how it failed: 0.0 seconds, far too fast for anything to
 * have tried to generate five seconds of audio.
 *
 * Removing them got a reply, and the reply had no audio in it. That is the
 * second thing, and it is the one that matters: **audio output requires
 * `stream: true`**. OpenRouter's own words. Without it a music model answers
 * with a perfectly ordinary chat completion and nothing else, which read as
 * "may not be a music model" about a model that certainly is.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const MP3 = Buffer.from('fake mp3 bytes here').toString('base64');

/** An SSE body, the way OpenRouter delivers one. */
function sse(events: unknown[]): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(
    new ReadableStream({
      start(controller) {
        // Split across reads on purpose: a chunk boundary mid-event is the
        // normal case on a real connection and the parser has to survive it.
        const bytes = new TextEncoder().encode(text);
        const half = Math.floor(bytes.length / 2);
        controller.enqueue(bytes.slice(0, half));
        controller.enqueue(bytes.slice(half));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

async function musicWith(respond: () => Response): Promise<{
  result: Buffer | null; sent: Record<string, unknown>; said: string[];
}> {
  let sent: Record<string, unknown> = {};
  const said: string[] = [];
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
  const result = await music('A calm piano phrase.', { seconds: 5, onError: (m) => said.push(m) });
  return { result, sent, said };
}

describe('generating a music bed', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('asks for a stream, without which no audio ever arrives', async () => {
    const { sent } = await musicWith(() => sse([{ choices: [{ delta: { audio: { data: MP3 } } }] }]));

    expect(sent.stream, 'audio output requires streaming').toBe(true);
    expect(sent.model).toBe('google/lyria-3-clip-preview');
  });

  it('sends no parameter the model does not accept', async () => {
    const { sent } = await musicWith(() => sse([{ choices: [{ delta: { audio: { data: MP3 } } }] }]));

    // The two that had the whole request refused in 0.0 seconds.
    expect(sent).not.toHaveProperty('modalities');
    expect(sent).not.toHaveProperty('audio');
  });

  it('joins the base64 across chunks before decoding it', async () => {
    /*
      A chunk is a slice of one encoded stream, not an independently padded
      string. Decoding each on its own corrupts the join, and the failure is
      silent — a file that exists and will not play.
    */
    const whole = Buffer.from('a longer piece of fake audio payload').toString('base64');
    const a = whole.slice(0, 7);
    const b = whole.slice(7);

    const { result } = await musicWith(() => sse([
      { choices: [{ delta: { audio: { data: a } } }] },
      { choices: [{ delta: { audio: { data: b } } }] },
    ]));

    expect(result?.toString()).toBe('a longer piece of fake audio payload');
  });

  it('ignores the chunks that carry only text', async () => {
    const { result } = await musicWith(() => sse([
      { choices: [{ delta: { role: 'assistant' } }] },
      { choices: [{ delta: { content: 'Here is a calm piano piece.' } }] },
      { choices: [{ delta: { audio: { data: MP3 } } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]));

    expect(result?.toString()).toBe('fake mp3 bytes here');
  });

  it('reads the non-streaming shape too', async () => {
    // The OpenAI audio-chat models answer with `message.audio.data` in a single
    // object. A reader that knows one shape reports silence about a reply that
    // had sound in it.
    const { result } = await musicWith(() => sse([{ choices: [{ message: { audio: { data: MP3 } } }] }]));
    expect(result?.toString()).toBe('fake mp3 bytes here');
  });

  it('reads audio handed back as a data URL', async () => {
    const { result } = await musicWith(() => sse([
      { choices: [{ delta: { audio: { url: `data:audio/mpeg;base64,${MP3}` } } }] },
    ]));
    expect(result?.toString()).toBe('fake mp3 bytes here');
  });

  it('says it streamed but sent no audio, and what it sent instead', async () => {
    /*
      Two different failures wanted two different sentences. "It streamed and
      none of it was audio" and "it never streamed at all" have different fixes,
      and one message for both is what kept this looking like a wrong model id.
    */
    const { result, said } = await musicWith(() => sse([
      { choices: [{ delta: { content: 'I cannot generate music.' } }] },
    ]));

    expect(result).toBeNull();
    expect(said.join(' ')).toContain('streamed a reply but no audio');
    expect(said.join(' '), 'name what did come back, so it is diagnosable').toContain('content');
  });

  it('says so plainly when nothing comes back at all', async () => {
    const { result, said } = await musicWith(() => sse([]));

    expect(result).toBeNull();
    expect(said.join(' ')).toContain('nothing back');
  });
});
