/**
 * Offering the models that can actually do the job.
 *
 * The eight model boxes told an admin to go to openrouter.ai and paste an id
 * back. Four of the eight shipped defaults were wrong, in four different ways,
 * and each one was only discovered by a feature failing. A box that sends
 * somebody elsewhere for its value is how that happens.
 *
 * The two things pinned hardest here are the ones that make this safe to depend
 * on: it never blocks the settings page, and it never narrows a job to models
 * that cannot do it.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const CHAT = {
  id: 'some/chat-model',
  name: 'Chat Model',
  pricing: { prompt: '0.000001', completion: '0.000002' },
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
};
const FREE = {
  id: 'some/free-model:free',
  name: 'Free Model',
  pricing: { prompt: '0', completion: '0' },
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
};
const SEEING = {
  id: 'some/vision-model',
  name: 'Vision Model',
  pricing: { prompt: '0', completion: '0' },
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
};

async function catalogue(job: string, respond: (url: string) => Response) {
  const seen: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    seen.push(String(url));
    return respond(String(url));
  }));
  const { modelsForJob, invalidateModelCatalogue } = await import('../../src/ai/modelCatalogue.js');
  invalidateModelCatalogue();
  const models = await modelsForJob(job);
  return { models, seen };
}

const ok = (data: unknown[]) => () => new Response(JSON.stringify({ data }), { status: 200 });

describe('the model catalogue', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('asks for the kind of model the job needs', async () => {
    const { seen } = await catalogue('embed', ok([]));
    // Search needs an embedding model. The plain models list is chat-only, which
    // is what made three real ids look non-existent when they were checked
    // against it.
    expect(seen[0]).toContain('output_modalities=embeddings');
  });

  it.each([
    ['music', 'audio'],
    ['speech', 'speech'],
    ['rerank', 'rerank'],
    ['video', 'video'],
    ['copy', 'text'],
  ])('asks for %s models by their own modality', async (job, modality) => {
    const { seen } = await catalogue(job, ok([]));
    expect(seen[0]).toContain(`output_modalities=${modality}`);
  });

  it('offers transcription models, because OpenRouter does serve them', async () => {
    /*
      This test used to assert the opposite, on the belief that OpenRouter is a
      chat gateway that cannot transcribe. It can: POST /audio/transcriptions,
      nineteen models. The belief came from checking an ASR id against the plain
      /models list, which is chat-only, finding nothing, and concluding the id
      was invented. `?output_modalities=transcription` is the list that has them.

      Note the modality name. It is `transcription`, not `stt` or `asr`, and it
      is not `speech` — that one is text-to-speech, the opposite direction.
    */
    const { seen } = await catalogue('transcribe', ok([]));
    expect(seen[0]).toContain('output_modalities=transcription');
  });

  it('asks for an unknown job nothing at all', async () => {
    const { models, seen } = await catalogue('not-a-job', ok([CHAT]));
    expect(models).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it('only offers models that can be shown a photo, for reading photos', async () => {
    const { models } = await catalogue('vision', ok([CHAT, SEEING]));
    expect(models.map((m) => m.id)).toEqual(['some/vision-model']);
  });

  it('puts the free ones first, and says what the rest cost', async () => {
    const { models } = await catalogue('copy', ok([CHAT, FREE]));
    expect(models[0]!.id).toBe('some/free-model:free');
    expect(models[0]!.price).toBe('Free');
    expect(models[1]!.free).toBe(false);
    // Rupees, not dollars-per-token. A price nobody can read is not a price.
    expect(models[1]!.price).toMatch(/₹/);
  });

  it('only calls a model free when OpenRouter itself says so', async () => {
    /*
      Empty pricing does not mean free. Every video model, every rerank model and
      both Lyria music models come back with nothing in the pricing block,
      because they are billed per second, per search unit or per clip on the
      endpoint rather than per token in this feed. Reading empty as free labelled
      the whole video list ₹0.

      Being told something costs money when it does not is a shrug. Being told a
      bill is free is a bill.
    */
    const { models } = await catalogue('video', ok([
      { id: 'some/video-model', name: 'Video', pricing: {}, architecture: { output_modalities: ['video'] } },
    ]));
    expect(models[0]!.free).toBe(false);
    expect(models[0]!.price).toBe('Priced per use');
  });

  it('answers with nothing when the catalogue cannot be reached', async () => {
    // The settings page must open whether or not OpenRouter is up. This is the
    // whole reason the box stays free text rather than becoming a dropdown.
    const { models } = await catalogue('copy', () => { throw new Error('network down'); });
    expect(models).toEqual([]);
  });

  it('answers with nothing when the catalogue answers with rubbish', async () => {
    const { models } = await catalogue('copy', () => new Response('not json at all', { status: 200 }));
    expect(models).toEqual([]);
  });

  it('answers with nothing on an error status rather than throwing', async () => {
    const { models } = await catalogue('copy', () => new Response('nope', { status: 500 }));
    expect(models).toEqual([]);
  });

  it('asks once and remembers, rather than on every keystroke', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [CHAT] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { modelsForJob, invalidateModelCatalogue } = await import('../../src/ai/modelCatalogue.js');
    invalidateModelCatalogue();

    await modelsForJob('copy');
    await modelsForJob('copy');
    await modelsForJob('copy');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
