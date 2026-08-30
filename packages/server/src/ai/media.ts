/**
 * The parts of AI that are not a chat completion.
 *
 * `client.ts` covers everything that takes text and gives text back, which is
 * most of the CRM. Four things it cannot do, and this module does: turn a
 * script into a voice, turn a recording into words, turn a brief into music,
 * and turn a still into a moving clip. Plus the two that make search work,
 * embeddings and reranking.
 *
 * Deliberately OpenRouter only, and deliberately not hidden behind the provider
 * fallback chain. These are separate endpoints, not model names — Gemini and
 * Groq do not answer at `/audio/speech`, so "try the next provider" would just
 * be a second 404. One provider, one key, an honest null when it is not
 * configured, and a log line saying why.
 *
 * Every function follows CLAUDE.md rule 7: no key means a null return, never a
 * throw. A property still gets its photos when there is no voice to put on the
 * video, and the caller decides what a missing piece means.
 */
import { modelFor, type AiJob } from '../core/settings/aiModels.js';
import { getAiProviderSettings, getSttProviderSettings } from '../core/settings/integrations.js';
import { db } from '../db/pool.js';
import { logger } from '../utils/logger.js';

/**
 * Which model does a job is a setting, not a constant.
 *
 * `core/settings/aiModels.ts` owns the list and the defaults; this module just
 * asks. That is the difference between swapping a model in a text box and
 * swapping it in a release.
 */
export { AI_JOBS, aiModels } from '../core/settings/aiModels.js';
export type MediaJob = AiJob;

interface Endpoint { baseUrl: string; apiKey: string }

/**
 * OpenRouter's own settings, whether or not it won provider resolution.
 *
 * `getSettings().ai` answers "who writes the CRM's text", which may well be
 * Gemini. That is a different question from "can we reach OpenRouter", and
 * reading the first to answer the second is how a configured key looks missing.
 */
function endpoint(): Endpoint | null {
  const settings = getAiProviderSettings('openrouter');
  if (!settings?.apiKey) return null;
  return {
    baseUrl: (settings.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
    apiKey: settings.apiKey,
  };
}

export function isMediaAiAvailable(): boolean {
  return endpoint() !== null;
}

/** Why a media feature is off, in words an admin can act on. */
export function mediaAiStatus(): { available: boolean; reason?: string } {
  return endpoint()
    ? { available: true }
    : {
      available: false,
      reason: 'Add an OpenRouter key in Admin → Integrations. Voice, transcription, '
        + 'music and search all run through it, and most of them are free. '
        + 'Which model does which job is then yours to change in Admin → Settings → AI models.',
    };
}

async function logCall(
  feature: string, model: string, latencyMs: number,
  success: boolean, error: string | null, recordId?: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO ipy_ai_log
      (feature, model, user_id, record_id, prompt_summary, input_tokens, output_tokens, latency_ms, success, error)
     VALUES ($1,$2,NULL,$3,$4,0,0,$5,$6,$7)`,
    [feature, model, recordId ?? null, feature, latencyMs, success, error],
  ).catch((err) => logger.debug({ err }, 'failed to write AI media log'));
}

/**
 * One request, with the retry that matters and none of the ones that do not.
 *
 * 429 and 5xx are worth a second go; a 400 means the request was wrong and
 * sending it again is just a slower failure.
 */
async function request(
  path: string,
  body: unknown,
  feature: string,
  model: string,
  opts: {
    raw?: boolean; recordId?: string | null; timeoutMs?: number;
    /**
     * Hands the provider's own words back to the caller.
     *
     * Everything here returns null on failure, so a caller could only ever say
     * "nothing came back" and then guess at why — which is how four settings
     * boxes ended up telling an admin to "check the id is an embedding model"
     * when what OpenRouter actually said was that the model does not exist. The
     * reason is right here in `lastError`; it was only ever being logged.
     */
    onError?: (message: string) => void;
  } = {},
): Promise<Response | null> {
  const target = endpoint();
  if (!target) {
    logger.debug({ feature }, 'no OpenRouter key; media AI unavailable');
    opts.onError?.('No OpenRouter key is saved. Add one in Admin → Integrations.');
    return null;
  }
  const started = Date.now();
  let lastError = '';

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);
    try {
      const response = await fetch(`${target.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${target.apiKey}`,
          'Content-Type': 'application/json',
          // OpenRouter attributes usage per app; without these every call shows
          // up in the dashboard as anonymous and nothing can be traced back.
          'HTTP-Referer': 'https://ipropy-crm.onrender.com',
          'X-Title': 'iPropy CRM',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (response.ok) {
        await logCall(feature, model, Date.now() - started, true, null, opts.recordId);
        return response;
      }
      lastError = `${response.status} ${(await response.text()).slice(0, 300)}`;
      if (response.status < 500 && response.status !== 429) break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }

  await logCall(feature, model, Date.now() - started, false, lastError.slice(0, 500), opts.recordId);
  logger.warn({ feature, model, error: lastError }, 'media AI call failed');
  opts.onError?.(lastError);
  return null;
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

export interface SpeechOptions {
  /** Called with the provider's own words when the call fails. */
  onError?: (message: string) => void;
  text: string;
  /** The provider's own voice name. Left to the caller; models disagree on these. */
  voice?: string;
  format?: 'mp3' | 'wav' | 'opus';
  model?: string;
  /** Slower than one for a property tour; the default reads too fast. */
  speed?: number;
  recordId?: string | null;
}

/**
 * A script becomes a voice track.
 *
 * The response is raw audio bytes rather than JSON, which is why this returns a
 * Buffer and not an object.
 */
export async function speak(opts: SpeechOptions): Promise<Buffer | null> {
  const model = opts.model ?? await modelFor('speech');
  const response = await request('/audio/speech', {
    model,
    input: opts.text,
    voice: opts.voice ?? 'alloy',
    response_format: opts.format ?? 'mp3',
    ...(opts.speed ? { speed: opts.speed } : {}),
  }, 'tts', model, { raw: true, recordId: opts.recordId, onError: opts.onError });
  if (!response) return null;
  return Buffer.from(await response.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Words out of a recording
// ---------------------------------------------------------------------------

export interface TranscriptResult {
  text: string;
  model: string;
  /** Present when the model returns them; not every one does. */
  segments?: { start: number; end: number; text: string }[];
}

/**
 * A call recording becomes text.
 *
 * One thing was wrong with this, not two, and the difference matters.
 *
 * The shape was wrong. It posted JSON with the audio base64-encoded under
 * `input_audio`, and the OpenAI-compatible transcription endpoint every provider
 * implements takes **multipart/form-data with a file part**. That alone is why
 * the settings box said "it could not read the audio" no matter which id was in
 * it, and no id would have fixed it.
 *
 * The host was **not** wrong, though it was written off here as one. OpenRouter
 * does transcribe: `POST /audio/transcriptions`, nineteen models, this exact
 * multipart shape. The mistake was checking the shipped id against
 * `/api/v1/models`, which is chat-only, finding nothing, and concluding the id
 * was invented. `?output_modalities=transcription` is the list that has them,
 * and the original default — `nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b`
 * — is the first entry in it.
 *
 * So both providers work, and which one is used comes down to which has a key.
 * A dedicated speech-to-text card wins when it is filled in, because filling it
 * in is a decision. Otherwise this goes to OpenRouter on the key that is already
 * there, which means transcription needs no new setup at all.
 *
 * Sent whole rather than chunked, deliberately: chunking splits sentences at the
 * boundary and the join is always audible in the text.
 */
export async function transcribe(
  audio: Buffer,
  format: string,
  opts: { model?: string; language?: string; recordId?: string | null;
    onError?: (message: string) => void } = {},
): Promise<TranscriptResult | null> {
  // The model is named in Admin → Settings → AI models like every other job;
  // the provider supplies only where to send it and what to sign it with.
  // Two boxes holding one model id is the pattern this CRM keeps getting wrong.
  const model = opts.model ?? await modelFor('transcribe');

  /*
    Two providers can do this, and which one is right depends on what has a key.

    A dedicated speech-to-text service — Groq's Whisper is the free one — wins
    when it is set up, because somebody who filled that card in meant it.

    Otherwise this goes to OpenRouter, which does transcribe: `/audio/
    transcriptions` with nineteen models behind it, taking exactly this multipart
    shape. That was written off here as "OpenRouter is a chat gateway and does
    not transcribe", which was wrong, and wrong in a way worth remembering: the
    plain `/models` list is chat-only, so an ASR id checked against it looks
    invented. It is `?output_modalities=transcription` that lists them. The
    original default, `nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b`, was
    real the whole time.

    Only the request shape was ever actually broken: JSON with the audio
    base64-encoded, where the endpoint wants a file part. That fix stands, and it
    is the same shape for both providers, which is why one code path serves both.
  */
  const stt = getSttProviderSettings();
  const openRouter = endpoint();
  const via = stt.apiKey
    ? { apiKey: stt.apiKey, baseUrl: stt.baseUrl || 'https://api.groq.com/openai/v1' }
    : openRouter;

  if (!via?.apiKey) {
    const why = 'No key is saved for transcription. Add one in Admin → Integrations, '
      + 'either on the Speech to text card or on OpenRouter.';
    logger.debug('transcription attempted with no key on either provider');
    opts.onError?.(why);
    return null;
  }

  const base = via.baseUrl.replace(/\/+$/, '');
  const started = Date.now();

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)]), `audio.${format.replace(/^\./, '').toLowerCase()}`);
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  if (opts.language) form.append('language', opts.language);

  try {
    const response = await fetch(`${base}/audio/transcriptions`, {
      method: 'POST',
      // No Content-Type: fetch sets it with the multipart boundary, and setting
      // it by hand omits the boundary and the request is rejected as malformed.
      headers: { Authorization: `Bearer ${via.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(300_000),
    });

    if (!response.ok) {
      const detail = `${response.status} ${(await response.text()).slice(0, 300)}`;
      await logCall('stt', model, Date.now() - started, false, detail.slice(0, 500), opts.recordId);
      logger.warn({ model, error: detail }, 'transcription failed');
      opts.onError?.(detail);
      return null;
    }

    const body = await response.json() as { text?: string; segments?: TranscriptResult['segments'] };
    await logCall('stt', model, Date.now() - started, true, null, opts.recordId);
    const text = (body.text ?? '').trim();
    // An empty string is a real answer for silence, and the caller decides what
    // to do with it. Returning null here made a silent recording look like a
    // failed one.
    return { text, model, segments: body.segments };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await logCall('stt', model, Date.now() - started, false, detail.slice(0, 500), opts.recordId);
    logger.warn({ err, model }, 'transcription failed');
    opts.onError?.(detail);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Music
// ---------------------------------------------------------------------------

/**
 * A brief becomes a music bed.
 *
 * Instrumental by default and said so in the prompt rather than as a flag,
 * because a track with words fights the voiceover and gets a video muted on
 * some platforms for the wrong reason.
 */
export async function music(
  brief: string,
  opts: { model?: string; seconds?: number; recordId?: string | null;
    onError?: (message: string) => void } = {},
): Promise<Buffer | null> {
  const model = opts.model ?? await modelFor('music');
  /*
    `modalities: ['audio']` and `audio: { format }` used to go with this, and
    they are not parameters the music models accept. OpenRouter lists exactly
    what each model takes, and Lyria's are `max_tokens, response_format, seed,
    temperature, top_p` — no `modalities`, no `audio`. An unsupported parameter
    is rejected outright, which matches what this looked like from outside: the
    settings test failed in 0.0 seconds, far too fast for anything to have tried
    to generate five seconds of music.

    These models already answer with audio because that is what they are; asking
    for it in a parameter they do not have is what stopped them.
  */
  const response = await request('/chat/completions', {
    model,
    messages: [{
      role: 'user',
      content: `Instrumental only, no vocals and no lyrics. ${brief} `
        + `About ${opts.seconds ?? 30} seconds.`,
    }],
  }, 'music', model, { recordId: opts.recordId, timeoutMs: 300_000, onError: opts.onError });
  if (!response) return null;

  /*
    Where the bytes arrive differs by provider, so all three known shapes are
    read rather than one: OpenAI puts base64 under `message.audio.data`, and
    OpenRouter hands attachments back as data URLs — under `audio` for some
    models and alongside `images` for others.
  */
  const body = await response.json() as {
    choices?: {
      message?: {
        audio?: { data?: string; url?: string };
        content?: string;
        images?: { image_url?: { url?: string } }[];
      };
    }[];
  };
  const message = body.choices?.[0]?.message;
  const fromDataUrl = (value?: string): string | null => {
    const match = /^data:audio\/[\w.+-]+;base64,(.+)$/.exec(value ?? '');
    return match?.[1] ?? null;
  };

  const data = message?.audio?.data
    ?? fromDataUrl(message?.audio?.url)
    ?? fromDataUrl(message?.content)
    ?? fromDataUrl(message?.images?.[0]?.image_url?.url);

  if (!data) {
    logger.warn({ model }, 'music model answered without audio');
    opts.onError?.('The model answered, but with no audio attached. It may not be a music model.');
    return null;
  }
  return Buffer.from(data, 'base64');
}

// ---------------------------------------------------------------------------
// Search: turning text into numbers, then putting the answers in the right order
// ---------------------------------------------------------------------------

/**
 * Vectors for a batch of texts, in the order they were given.
 *
 * Batched rather than one call per row because the cost here is the round trip,
 * not the tokens: this model is free.
 */
export async function embed(
  texts: string[],
  opts: { model?: string; onError?: (message: string) => void } = {},
): Promise<number[][] | null> {
  if (!texts.length) return [];
  const model = opts.model ?? await modelFor('embed');
  const response = await request('/embeddings', { model, input: texts }, 'embed', model, { onError: opts.onError });
  if (!response) return null;

  const body = await response.json() as { data?: { embedding?: number[]; index?: number }[] };
  const rows = body.data ?? [];
  if (rows.length !== texts.length) {
    logger.warn({ asked: texts.length, got: rows.length }, 'embedding count mismatch');
    return null;
  }
  // Index is authoritative when present: nothing promises the array comes back
  // in order, and a silently shuffled batch attaches every vector to the wrong
  // record, which reads as "search is bad" rather than as a bug.
  const out: number[][] = new Array(texts.length);
  rows.forEach((row, position) => {
    out[row.index ?? position] = row.embedding ?? [];
  });
  return out.every((v) => v?.length) ? out : null;
}

export interface RerankHit { index: number; score: number }

/**
 * Put a shortlist in the right order for one specific question.
 *
 * Embedding search is good at "roughly about this" and bad at ranking, which is
 * why the two are separate steps. Retrieve fifty by vector, rerank to the five
 * that actually answer what was asked.
 */
export async function rerank(
  query: string,
  documents: string[],
  opts: { model?: string; topN?: number; onError?: (message: string) => void } = {},
): Promise<RerankHit[] | null> {
  if (!documents.length) return [];
  const model = opts.model ?? await modelFor('rerank');
  const response = await request('/rerank', {
    model,
    query,
    documents,
    top_n: Math.min(opts.topN ?? documents.length, documents.length),
  }, 'rerank', model, { onError: opts.onError });
  if (!response) return null;

  const body = await response.json() as {
    results?: { index?: number; relevance_score?: number; score?: number }[];
  };
  const results = body.results ?? [];
  if (!results.length) return null;
  return results
    .map((r) => ({ index: r.index ?? 0, score: r.relevance_score ?? r.score ?? 0 }))
    .sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Video, which is the only one of these that costs real money
// ---------------------------------------------------------------------------

export interface VideoRequest {
  prompt: string;
  /** A still to move from, as a data URL. Anchors the clip to the real room. */
  imageDataUrl?: string;
  seconds?: number;
  size?: string;
  model?: string;
  recordId?: string | null;
}

/**
 * One short clip, generated.
 *
 * Asynchronous by design at the provider: the call returns a job and the result
 * arrives minutes later. Polled here rather than webhooked because the CRM
 * cannot be relied on to hold a callback URL a worker behind a home router can
 * reach — the same reason n8n polls rather than being called.
 *
 * The one part of this module with a real bill attached. Everything else is
 * free or close to it; this is roughly a rupee a second at 480p, so it is meant
 * for a single opening shot and nothing longer.
 */
export async function generateVideo(req: VideoRequest): Promise<Buffer | null> {
  const model = req.model ?? await modelFor('video');
  const response = await request('/videos', {
    model,
    prompt: req.prompt,
    ...(req.imageDataUrl ? { input_reference: { first_frame: req.imageDataUrl } } : {}),
    seconds: req.seconds ?? 5,
    size: req.size ?? '720x1280',
  }, 'video', model, { recordId: req.recordId, timeoutMs: 120_000 });
  if (!response) return null;

  const started = await response.json() as { id?: string; status?: string };
  if (!started.id) return null;

  const target = endpoint();
  if (!target) return null;

  // Twenty minutes at ten second intervals. A clip that has not landed by then
  // is not coming, and the caller has photos to fall back on.
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((r) => setTimeout(r, 10_000));
    const poll = await fetch(`${target.baseUrl}/videos/${started.id}`, {
      headers: { Authorization: `Bearer ${target.apiKey}` },
    }).catch(() => null);
    if (!poll?.ok) continue;

    const job = await poll.json() as {
      status?: string;
      error?: { message?: string };
      output?: { url?: string }[] | { url?: string };
    };
    if (job.status === 'failed' || job.error) {
      logger.warn({ model, error: job.error?.message }, 'video generation failed');
      return null;
    }
    if (job.status !== 'completed' && job.status !== 'succeeded') continue;

    const url = Array.isArray(job.output) ? job.output[0]?.url : job.output?.url;
    if (!url) return null;
    const file = await fetch(url).catch(() => null);
    if (!file?.ok) return null;
    return Buffer.from(await file.arrayBuffer());
  }
  logger.warn({ model }, 'video generation timed out');
  return null;
}
