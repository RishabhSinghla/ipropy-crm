/**
 * Which model does which job, as a setting rather than as a line of code.
 *
 * Eight jobs, eight boxes in Admin → Settings. Paste a different id from
 * OpenRouter's model list, save, and the next job uses it. No deploy, no
 * developer, no waiting.
 *
 * This exists because the alternative was `MEDIA_MODELS` as a constant, and a
 * constant is a promise that nobody will ever want to change it. Models on that
 * list are replaced every few weeks; a better vision model at half the price
 * appearing on a Tuesday should be a copy and a paste, not a release.
 *
 * The constants are still here, as the floor. A blank setting, a nonsense
 * setting, or a database that will not answer all land on the same value the
 * code shipped with, so the pipeline cannot be switched off by a typo.
 */
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';

/** One entry per job the CRM asks a model to do. */
export const AI_JOBS = {
  vision: {
    key: 'ai_models.vision',
    label: 'Read photos and video',
    fallback: 'xiaomi/mimo-v2.5',
    description: 'Looks at property photographs and watches the walkthrough. Must be a model that accepts images.',
  },
  copy: {
    key: 'ai_models.copy',
    label: 'Write listing copy',
    fallback: 'xiaomi/mimo-v2.5',
    description: 'Writes the title, description, captions and voiceover script. Text only, so a cheaper model is fine here.',
  },
  speech: {
    key: 'ai_models.speech',
    label: 'Voiceover',
    fallback: 'fish-audio/s2.1-pro-free:free',
    description: 'Turns the script into a voice for the property videos.',
  },
  music: {
    key: 'ai_models.music',
    label: 'Music',
    fallback: 'google/lyria-3-clip-preview',
    description: 'Writes the backing track. Charged per clip, so this is the only part of a property video that costs anything.',
  },
  transcribe: {
    key: 'ai_models.transcribe',
    label: 'Transcribe recordings',
    fallback: 'nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b',
    description: 'Turns call recordings and voice notes into words. Handles Hindi and English mixed together.',
  },
  embed: {
    key: 'ai_models.embed',
    label: 'Search',
    fallback: 'nvidia/nemotron-3-embed-1b:free',
    description: 'Powers search by meaning across leads, notes, messages and calls. Changing this re-indexes over the following hour.',
  },
  rerank: {
    key: 'ai_models.rerank',
    label: 'Reorder results',
    fallback: 'nvidia/llama-nemotron-rerank-vl-1b-v2:free',
    description: 'Puts search results in the right order for the question that was asked.',
  },
  video: {
    key: 'ai_models.video',
    label: 'Generate video',
    fallback: 'bytedance/seedance-2.0-mini',
    description: 'Only used for a single opening clip, and only when that is switched on. Charged per second.',
  },
} as const;

export type AiJob = keyof typeof AI_JOBS;

let cached: Record<AiJob, string> | null = null;

export function invalidateAiModels(): void {
  cached = null;
}

function defaults(): Record<AiJob, string> {
  return Object.fromEntries(
    (Object.keys(AI_JOBS) as AiJob[]).map((job) => [job, AI_JOBS[job].fallback]),
  ) as Record<AiJob, string>;
}

/**
 * A model id is a slug, and anything that is not one would be sent to the
 * provider as a 404 on every call. Checked here so a stray space or a pasted
 * price does not silently take a feature offline.
 */
function usable(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return /^[a-z0-9][a-z0-9._/-]{2,120}(:[a-z0-9-]+)?$/i.test(value) ? value : null;
}

export async function aiModels(): Promise<Record<AiJob, string>> {
  if (cached) return cached;
  const fallback = defaults();

  try {
    const rows = await db.query<{ key: string; value: unknown }>(
      `SELECT key, value FROM ipy_setting WHERE key = ANY($1)`,
      [Object.values(AI_JOBS).map((j) => j.key)],
    );
    const map = new Map(rows.rows.map((r) => [r.key, r.value]));
    const next = { ...fallback };
    for (const job of Object.keys(AI_JOBS) as AiJob[]) {
      // Per key, not wholesale: one bad box should cost that one job, not send
      // every model back to the default and change eight things nobody touched.
      const chosen = usable(map.get(AI_JOBS[job].key));
      if (chosen) next[job] = chosen;
    }
    cached = next;
    return next;
  } catch (err) {
    logger.warn({ err }, 'could not read AI model settings, using defaults');
    return fallback;
  }
}

/** The model for one job, or the shipped default. */
export async function modelFor(job: AiJob): Promise<string> {
  return (await aiModels())[job];
}
