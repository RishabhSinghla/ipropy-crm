/**
 * One switch per AI feature, and nothing load-bearing.
 *
 * The rule this enforces: every one of these can be off, and the CRM is a
 * working CRM with all of them off. Suggested replies that annoy a rep are one
 * toggle away from gone, and turning them off must not take anything else with
 * them.
 *
 * Default is on for the ones that cost nothing and only suggest, and off for
 * the one that costs real money.
 */
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';

export const AI_FEATURES = {
  photoCulling: {
    key: 'ai_features.photo_culling',
    label: 'Hold back weak photos',
    fallback: true,
    description: 'The naming pass already scores every photo. Below the score you set, a photo stays in RAW-UPLOADS and is not published anywhere.',
  },
  voiceNotes: {
    key: 'ai_features.voice_notes',
    label: 'Voice notes on a lead',
    fallback: true,
    description: 'A microphone on the notes panel. Speak in Hinglish, it writes the note.',
  },
  duplicateSuggestions: {
    key: 'ai_features.duplicate_suggestions',
    label: 'Spot the same person twice',
    fallback: true,
    description: 'Suggests a merge when a new lead looks like one you already have. It only ever suggests.',
  },
  documentReading: {
    key: 'ai_features.document_reading',
    label: 'Read uploaded documents',
    fallback: true,
    description: 'Pulls dates, amounts and numbers out of agreements and certificates, and makes floor plans findable by what is on them.',
  },
  firstReply: {
    key: 'ai_features.first_reply',
    label: 'Draft the first reply',
    fallback: true,
    description: 'A new enquiry arrives with a WhatsApp already written, waiting for somebody to tap send.',
  },
  replySuggestions: {
    key: 'ai_features.reply_suggestions',
    label: 'Suggest replies in the Inbox',
    fallback: true,
    description: 'Three suggested answers under each incoming message.',
  },
  morningBrief: {
    key: 'ai_features.morning_brief',
    label: 'Morning brief',
    fallback: true,
    description: 'Each person gets their day at 9am as a phone notification.',
  },
  videoGeneration: {
    key: 'ai_features.video_generation',
    label: 'Generate an opening clip',
    fallback: false,
    description: 'One short generated shot at the front of a property reel. This is the only AI feature that costs real money, roughly ₹6 a property, and it is the only one that puts a frame on screen nobody photographed.',
  },
} as const;

export type AiFeature = keyof typeof AI_FEATURES;

let cached: Record<AiFeature, boolean> | null = null;

export function invalidateAiFeatures(): void {
  cached = null;
}

export async function aiFeatures(): Promise<Record<AiFeature, boolean>> {
  if (cached) return cached;
  const fallback = Object.fromEntries(
    (Object.keys(AI_FEATURES) as AiFeature[]).map((f) => [f, AI_FEATURES[f].fallback]),
  ) as Record<AiFeature, boolean>;

  try {
    const rows = await db.query<{ key: string; value: unknown }>(
      `SELECT key, value FROM ipy_setting WHERE key = ANY($1)`,
      [Object.values(AI_FEATURES).map((f) => f.key)],
    );
    const map = new Map(rows.rows.map((r) => [r.key, r.value]));
    const next = { ...fallback };
    for (const feature of Object.keys(AI_FEATURES) as AiFeature[]) {
      const raw = map.get(AI_FEATURES[feature].key);
      if (typeof raw === 'boolean') next[feature] = raw;
      else if (raw === 'true' || raw === 'false') next[feature] = raw === 'true';
    }
    cached = next;
    return next;
  } catch (err) {
    logger.warn({ err }, 'could not read AI feature switches, using defaults');
    return fallback;
  }
}

export async function featureOn(feature: AiFeature): Promise<boolean> {
  return (await aiFeatures())[feature];
}
