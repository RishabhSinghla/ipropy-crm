/**
 * AI photo editing — virtual staging, decluttering, sky replacement.
 *
 * The single highest-value creative feature for a property business, and it
 * runs on the Gemini key that is already in the integrations table. An empty
 * builder floor photographed on a grey Faridabad afternoon becomes a furnished
 * room under a blue sky, which is the difference between a listing people
 * scroll past and one they enquire about.
 *
 * This does **not** go through `ai/client.ts`. That module speaks the OpenAI
 * chat-completions shape, which has no way to return an image — image output is
 * Gemini's native `generateContent` with `responseModalities`, a different
 * endpoint and a different response shape. Sharing the settings resolution but
 * not the transport is the honest split.
 *
 * Degradation, as everywhere else: no Gemini key means `null` and a reason the
 * UI can show, never a throw. The studio's own filters still work, and so does
 * the browser-side background remover, so the feature list only shrinks by the
 * things that genuinely need a model.
 */
import sharp from 'sharp';
import { getAiProviderSettings } from '../core/settings/integrations.js';
import { db } from '../db/pool.js';
import { logger } from '../utils/logger.js';

/**
 * Image generation is a separate model family from text, and the text model
 * configured for the workspace (`gemini-flash-latest`) cannot return pixels.
 * Pinned to the alias rather than a dated build for the reason migration 018
 * exists: Google retires dated model ids and the alias keeps working.
 */
const IMAGE_MODELS = [
  { id: 'gemini-3.1-flash-image', apiVersion: 'v1' },
  // Existing AI Studio projects may not yet expose 3.1. The older image model
  // remains a compatibility fallback, but only when Google returns 404.
  { id: 'gemini-2.5-flash-image', apiVersion: 'v1beta' },
] as const;
const ENDPOINT = 'https://generativelanguage.googleapis.com';

/** Gemini rejects oversized inline payloads; a listing photo does not need more. */
const MAX_EDGE = 2048;

export type EditPreset =
  | 'virtual_stage' | 'declutter' | 'sky_replace' | 'enhance' | 'daylight' | 'custom';

/**
 * Prompts are written as instructions to a photo retoucher, not as image
 * descriptions. "Keep the architecture unchanged" appears in nearly all of them
 * because the failure that matters here is not an ugly result — it is a
 * beautiful photo of a room that does not exist, which in a property
 * transaction is a misrepresentation.
 */
const PRESETS: Record<Exclude<EditPreset, 'custom'>, { label: string; prompt: string }> = {
  virtual_stage: {
    label: 'Virtually stage',
    prompt:
      'Furnish this empty room realistically for an Indian upper-middle-class family home. '
      + 'Add appropriate furniture, a rug, soft furnishings and a few plants, in a warm contemporary style. '
      + 'Do not change the room\'s architecture, dimensions, windows, doors, flooring or wall positions. '
      + 'Keep the existing lighting direction. The result must look like a photograph of this exact room, furnished.',
  },
  declutter: {
    label: 'Remove clutter',
    prompt:
      'Remove clutter, personal belongings, loose wires, cleaning equipment and construction debris from this room. '
      + 'Keep all permanent fixtures, furniture, flooring and architecture exactly as they are. '
      + 'The result must look like the same room, tidied — not a different room.',
  },
  sky_replace: {
    label: 'Better sky',
    prompt:
      'Replace the dull or overexposed sky in this property photograph with a natural clear blue sky '
      + 'with light clouds, matching the lighting and shadows already in the image. '
      + 'Do not alter the building, its colour, the landscaping or anything below the roofline.',
  },
  enhance: {
    label: 'Enhance',
    prompt:
      'Improve this property photograph as a professional real-estate retoucher would: correct the white balance, '
      + 'lift the shadows, recover blown highlights, straighten the verticals and increase clarity slightly. '
      + 'Keep it photographic and believable — do not add, remove or move anything in the scene.',
  },
  daylight: {
    label: 'Day conversion',
    prompt:
      'Convert this photograph taken in poor or evening light into bright natural daylight. '
      + 'Keep the scene, the architecture and every object identical; change only the lighting, '
      + 'with realistic shadows consistent with midday sun.',
  },
};

export function listPresets(): { key: EditPreset; label: string }[] {
  return [
    ...Object.entries(PRESETS).map(([key, value]) => ({ key: key as EditPreset, label: value.label })),
    { key: 'custom' as EditPreset, label: 'Describe the change' },
  ];
}

export function isImageEditAvailable(): boolean {
  const gemini = getAiProviderSettings('gemini');
  return Boolean(gemini?.apiKey);
}

export interface EditResult {
  buffer: Buffer;
  mime: string;
}

export async function editImage(input: {
  image: Buffer;
  preset: EditPreset;
  instruction?: string;
  userId?: string | null;
}): Promise<{ ok: true; result: EditResult } | { ok: false; reason: string }> {
  const gemini = getAiProviderSettings('gemini');
  if (!gemini?.apiKey) {
    return {
      ok: false,
      reason: 'AI photo editing needs a Google AI Studio key. Add one in Admin → Integrations → Gemini.',
    };
  }

  const prompt = input.preset === 'custom'
    ? (input.instruction ?? '').trim()
    : PRESETS[input.preset]?.prompt;
  if (!prompt) return { ok: false, reason: 'Describe the change you want before running the edit.' };

  // Downscale before upload rather than after: a 12MP phone photo is ~8MB of
  // base64 on the wire and the model does not use the extra pixels.
  const prepared = await sharp(input.image)
    .rotate()
    .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 92 })
    .toBuffer();

  const started = Date.now();
  try {
    let response: Response | null = null;
    let body: {
      candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string }; inline_data?: { data?: string; mime_type?: string } }[] } }[];
      error?: { message?: string; status?: string };
      promptFeedback?: { blockReason?: string };
    } = {};
    let model: string = IMAGE_MODELS[0].id;

    for (const candidate of IMAGE_MODELS) {
      model = candidate.id;
      response = await fetch(`${ENDPOINT}/${candidate.apiVersion}/models/${candidate.id}:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': gemini.apiKey,
        },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { text: prompt },
              { inline_data: { mime_type: 'image/jpeg', data: prepared.toString('base64') } },
            ],
          }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
        }),
        signal: AbortSignal.timeout(90_000),
      });
      body = await response.json().catch(() => ({})) as typeof body;
      if (response.status !== 404 || candidate === IMAGE_MODELS.at(-1)) break;
    }

    const res = response!;

    if (!res.ok) {
      const message = body.error?.message ?? `HTTP ${res.status}`;
      await logEdit(input, model, Date.now() - started, false, message);
      return { ok: false, reason: friendlyError(res.status, message, model) };
    }

    if (body.promptFeedback?.blockReason) {
      return { ok: false, reason: `The model declined this edit (${body.promptFeedback.blockReason}). Try rewording the instruction.` };
    }

    // The response uses camelCase over REST and snake_case in some SDK paths;
    // accepting both costs one line and avoids a silent empty result.
    const part = body.candidates?.[0]?.content?.parts
      ?.find((p) => p.inlineData?.data || p.inline_data?.data);
    const base64 = part?.inlineData?.data ?? part?.inline_data?.data;

    if (!base64) {
      await logEdit(input, model, Date.now() - started, false, 'no image in response');
      return { ok: false, reason: 'The model replied without an image. Try a simpler instruction, or a different photo.' };
    }

    const raw = Buffer.from(base64, 'base64');
    // Normalise whatever came back to JPEG so downstream (storage, canvas,
    // the PDF writer) only ever deals with one format.
    const buffer = await sharp(raw).jpeg({ quality: 92 }).toBuffer();

    await logEdit(input, model, Date.now() - started, true, null);
    return { ok: true, result: { buffer, mime: 'image/jpeg' } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'AI image edit failed');
    await logEdit(input, IMAGE_MODELS[0].id, Date.now() - started, false, message);
    return {
      ok: false,
      reason: message.includes('timeout') || message.includes('aborted')
        ? 'The edit took too long and was cancelled. Large photos on a slow connection are the usual cause.'
        : `The edit could not be completed: ${message}`,
    };
  }
}

function friendlyError(status: number, message: string, model: string): string {
  if (status === 401 || status === 403) {
    return 'Google rejected the API key for image editing. Check the key in Admin → Integrations → Gemini.';
  }
  if (status === 404) {
    return `The image model "${model}" is not available to this key. Image generation is not enabled on every Google AI Studio project.`;
  }
  if (status === 429) {
    return 'Google\'s image-generation rate limit was hit. Wait a minute and try again.';
  }
  return message;
}

/** Same audit table every other AI call writes to, so cost and usage stay in one place. */
async function logEdit(
  input: { preset: EditPreset; userId?: string | null },
  model: string,
  ms: number,
  success: boolean,
  error: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO ipy_ai_log (feature, model, user_id, latency_ms, success, error)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [`image_edit:${input.preset}`, model, input.userId ?? null, ms, success, error],
  ).catch((err) => logger.debug({ err }, 'could not write AI log row'));
}
