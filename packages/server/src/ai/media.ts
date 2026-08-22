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
import { getAiProviderSettings } from '../core/settings/integrations.js';
import { db } from '../db/pool.js';
import { logger } from '../utils/logger.js';

/** What each job asks for by default, and what it costs at the time of writing. */
export const MEDIA_MODELS = {
  /** Text, image, audio and video in. Reads photos and watches walkthroughs. */
  vision: 'xiaomi/mimo-v2.5',
  /** Free tier. Handles Hinglish, which is what this business actually speaks. */
  speech: 'fish-audio/s2.1-pro-free:free',
  /** $0.012 an hour of audio. Call recordings cost almost nothing to read. */
  transcribe: 'nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b',
  /** $0.04 for a 30 second clip. */
  music: 'google/lyria-3-clip-preview',
  /** Free. 1B parameters, which is plenty for a CRM's worth of text. */
  embed: 'nvidia/nemotron-3-embed-1b:free',
  /** Free. Reorders what the embedding search found, which is where the win is. */
  rerank: 'nvidia/llama-nemotron-rerank-vl-1b-v2:free',
  /** Priced per video token. Only ever used for one short clip per property. */
  video: 'bytedance/seedance-2.0-mini',
} as const;

export type MediaJob = keyof typeof MEDIA_MODELS;

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
        + 'music and search all run through it, and most of them are free.',
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
  opts: { raw?: boolean; recordId?: string | null; timeoutMs?: number } = {},
): Promise<Response | null> {
  const target = endpoint();
  if (!target) {
    logger.debug({ feature }, 'no OpenRouter key; media AI unavailable');
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
  return null;
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

export interface SpeechOptions {
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
  const model = opts.model ?? MEDIA_MODELS.speech;
  const response = await request('/audio/speech', {
    model,
    input: opts.text,
    voice: opts.voice ?? 'alloy',
    response_format: opts.format ?? 'mp3',
    ...(opts.speed ? { speed: opts.speed } : {}),
  }, 'tts', model, { raw: true, recordId: opts.recordId });
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
 * The audio goes up base64 inside JSON rather than as multipart, which is what
 * this endpoint accepts. A ten minute call is a few megabytes, well inside a
 * normal request, so there is no chunking here on purpose: chunking splits
 * sentences across boundaries and the join is always visible.
 */
export async function transcribe(
  audio: Buffer,
  format: string,
  opts: { model?: string; language?: string; recordId?: string | null } = {},
): Promise<TranscriptResult | null> {
  const model = opts.model ?? MEDIA_MODELS.transcribe;
  const response = await request('/audio/transcriptions', {
    model,
    input_audio: { data: audio.toString('base64'), format: format.replace(/^\./, '').toLowerCase() },
    ...(opts.language ? { language: opts.language } : {}),
  }, 'stt', model, { recordId: opts.recordId, timeoutMs: 300_000 });
  if (!response) return null;

  const body = await response.json() as { text?: string; segments?: TranscriptResult['segments'] };
  const text = (body.text ?? '').trim();
  if (!text) return null;
  return { text, model, segments: body.segments };
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
  opts: { model?: string; seconds?: number; recordId?: string | null } = {},
): Promise<Buffer | null> {
  const model = opts.model ?? MEDIA_MODELS.music;
  const response = await request('/chat/completions', {
    model,
    modalities: ['audio'],
    audio: { format: 'mp3' },
    messages: [{
      role: 'user',
      content: `Instrumental only, no vocals and no lyrics. ${brief} `
        + `About ${opts.seconds ?? 30} seconds.`,
    }],
  }, 'music', model, { recordId: opts.recordId, timeoutMs: 300_000 });
  if (!response) return null;

  const body = await response.json() as {
    choices?: { message?: { audio?: { data?: string } } }[];
  };
  const data = body.choices?.[0]?.message?.audio?.data;
  if (!data) {
    logger.warn({ model }, 'music model returned no audio');
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
  opts: { model?: string } = {},
): Promise<number[][] | null> {
  if (!texts.length) return [];
  const model = opts.model ?? MEDIA_MODELS.embed;
  const response = await request('/embeddings', { model, input: texts }, 'embed', model);
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
  opts: { model?: string; topN?: number } = {},
): Promise<RerankHit[] | null> {
  if (!documents.length) return [];
  const model = opts.model ?? MEDIA_MODELS.rerank;
  const response = await request('/rerank', {
    model,
    query,
    documents,
    top_n: Math.min(opts.topN ?? documents.length, documents.length),
  }, 'rerank', model);
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
  const model = req.model ?? MEDIA_MODELS.video;
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
