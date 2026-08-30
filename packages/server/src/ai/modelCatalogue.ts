/**
 * What models actually exist, for each job.
 *
 * The eight model boxes in Admin → Settings → AI models used to say "paste a
 * model id from openrouter.ai/models". So an id got typed in by hand, and four
 * of the eight shipped defaults were wrong in four different ways. A box that
 * asks somebody to go and find a value elsewhere is how that happens.
 *
 * OpenRouter publishes its catalogue and lets it be filtered by what a model
 * puts out, so each box can offer the models that can actually do that job.
 * Music offers music models; the search box cannot be handed a chat model.
 *
 * Two things this deliberately is not:
 *
 * It is not validation. The box stays free text, because a suggestion list goes
 * stale the day a model is retired and being unable to type the id that works is
 * worse than being offered one that does not. The Test button is what proves an
 * id, and it makes the real call.
 *
 * It is not a hard dependency. Every failure here — no network, a changed shape,
 * a slow reply — returns an empty list. The settings page then behaves exactly
 * as it did before: a plain text box. Nothing about saving a model may depend on
 * a third party being reachable.
 */
import { logger } from '../utils/logger.js';

export interface CatalogueModel {
  id: string;
  name: string;
  /** Free to call. Sorted first, because the ₹0 ceiling is the whole point. */
  free: boolean;
  /** Rupees per million tokens, or per call for the ones priced that way. */
  price: string;
}

/**
 * Which models suit which job.
 *
 * `modality` is what OpenRouter calls the thing a model puts out, and the names
 * are not guessable — `speech` is text-to-speech while `transcription` is the
 * other direction, and neither appears in the plain `/models` list, which is
 * chat-only. Checking a speech or embedding or ASR id against that list finds
 * nothing and reads as "this model does not exist". That is exactly the mistake
 * that got four working ids written off as invented.
 *
 * `transcribe` is here despite going through the speech-to-text card when one is
 * set up, because when one is not it goes to OpenRouter, which does serve
 * nineteen transcription models.
 */
const JOB_MODALITY: Record<string, { modality: string; needsImageInput?: boolean }> = {
  copy: { modality: 'text' },
  vision: { modality: 'text', needsImageInput: true },
  speech: { modality: 'speech' },
  transcribe: { modality: 'transcription' },
  music: { modality: 'audio' },
  embed: { modality: 'embeddings' },
  rerank: { modality: 'rerank' },
  video: { modality: 'video' },
};

interface Entry { at: number; models: CatalogueModel[] }
const cache = new Map<string, Entry>();
const TTL_MS = 60 * 60 * 1000;

export function invalidateModelCatalogue(): void {
  cache.clear();
}

/**
 * What one model costs, in rupees, for reading at a glance.
 *
 * The `:free` suffix is OpenRouter's own marker and is the only thing here
 * trusted to mean free. An empty pricing block does **not** mean free: video,
 * rerank and the Lyria music models all come back with nothing in it, because
 * they are billed per second, per search unit or per clip on the endpoint
 * rather than per token in this feed. Reading empty as free labelled every
 * video model ₹0, which is the one mistake worth avoiding here — being told
 * something costs money when it does not is a shrug, and being told a bill is
 * free is a bill.
 */
function priceLabel(id: string, pricing: Record<string, string> | undefined): { free: boolean; price: string } {
  if (id.endsWith(':free')) return { free: true, price: 'Free' };

  const prompt = Number(pricing?.prompt ?? 0);
  const completion = Number(pricing?.completion ?? 0);
  const request = Number(pricing?.request ?? 0);

  if (request && !prompt && !completion) return { free: false, price: `₹${(request * 88).toFixed(2)} per call` };
  if (!prompt && !completion) return { free: false, price: 'Priced per use' };

  // Dollars per token in the feed. A million of them, at roughly ₹88, is a
  // number somebody can hold in their head; per-token is not.
  const perMillion = (prompt + completion) * 1_000_000 * 88;
  if (perMillion < 1) return { free: false, price: 'Under ₹1 per million' };
  return { free: false, price: `₹${Math.round(perMillion)} per million` };
}

interface RawModel {
  id?: string;
  name?: string;
  pricing?: Record<string, string>;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
}

/**
 * The models that can do one job, cheapest first.
 *
 * Empty is a valid answer and the caller must treat it as one.
 */
export async function modelsForJob(job: string): Promise<CatalogueModel[]> {
  const spec = JOB_MODALITY[job];
  if (!spec) return [];

  const hit = cache.get(job);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.models;

  try {
    const response = await fetch(
      `https://openrouter.ai/api/v1/models?output_modalities=${encodeURIComponent(spec.modality)}`,
      { signal: AbortSignal.timeout(8_000), headers: { 'X-Title': 'iPropy CRM' } },
    );
    if (!response.ok) throw new Error(`${response.status}`);

    const body = await response.json() as { data?: RawModel[] };
    const models = (body.data ?? [])
      .filter((m): m is RawModel & { id: string } => typeof m.id === 'string')
      // Reading a photo needs a model that can be shown one. Without this the
      // vision box offers every chat model, most of which are text-only, and
      // picking one fails at the first property photo rather than here.
      .filter((m) => !spec.needsImageInput || (m.architecture?.input_modalities ?? []).includes('image'))
      .map((m) => {
        const { free, price } = priceLabel(m.id, m.pricing);
        return { id: m.id, name: m.name || m.id, free, price };
      })
      // Free first, then alphabetical, so the ₹0 options are the ones in view.
      .sort((a, b) => (Number(b.free) - Number(a.free)) || a.id.localeCompare(b.id));

    cache.set(job, { at: Date.now(), models });
    return models;
  } catch (err) {
    // Deliberately quiet and deliberately empty. A settings page that cannot
    // open because a catalogue is unreachable is a far worse failure than a
    // text box with no suggestions in it.
    logger.debug({ job, err: err instanceof Error ? err.message : String(err) }, 'model catalogue unavailable');
    return [];
  }
}
