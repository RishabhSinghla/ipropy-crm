/** AI room/space labels for photos that survived conservative culling. */
import sharp from 'sharp';
import { db } from '../../db/pool.js';
import { completeJson, isAiAvailable, type VisionImage } from '../../ai/client.js';
import { getDriver } from '../storage/index.js';
import { logger } from '../../utils/logger.js';

export const PHOTO_CATEGORIES = [
  'facade', 'entrance', 'living_room', 'dining_room', 'kitchen', 'bedroom',
  'bathroom', 'balcony', 'parking', 'lift_lobby', 'terrace', 'view',
  'floor_plan', 'utility', 'other',
] as const;
export type PhotoCategory = typeof PHOTO_CATEGORIES[number];

const CATEGORY_SET = new Set<string>(PHOTO_CATEGORIES);
const MAX_ATTEMPTS = 3;
const PHOTOS_PER_CALL = 8;
const RECORDS_PER_TICK = 2;

interface PhotoRow {
  id: string;
  storage_key: string;
  variants: Record<string, string> | null;
  ai_classification_attempts: number;
}

interface PreparedPhoto { id: string; image: VisionImage }
interface RawPhoto {
  number?: unknown;
  category?: unknown;
  caption?: unknown;
  confidence?: unknown;
}
interface RawClassification { photos?: unknown }

const SYSTEM = `You classify photographs from Indian residential property visits.

Only describe what is visibly present. Never infer or state an address, house number, locality, price, area, ownership, legal status, approval, possession status or room count. A visible room label is an organisational hint, not an authoritative property fact.`;

function normaliseCategory(input: unknown): PhotoCategory {
  const category = String(input ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return CATEGORY_SET.has(category) ? category as PhotoCategory : 'other';
}

function confidence(input: unknown): number {
  const value = Number(input);
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
}

async function prepare(rows: PhotoRow[]): Promise<PreparedPhoto[]> {
  const driver = await getDriver();
  const prepared: PreparedPhoto[] = [];
  for (const row of rows) {
    try {
      const key = row.variants?.medium ?? row.variants?.large ?? row.storage_key;
      const source = await driver.read(key);
      if (!source) continue;
      const data = await sharp(source, { failOn: 'none' })
        .rotate()
        .resize(768, 768, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 75 })
        .toBuffer();
      prepared.push({ id: row.id, image: { data, mimeType: 'image/jpeg' } });
    } catch (err) {
      logger.debug({ err, attachmentId: row.id }, 'photo classify: could not prepare image');
    }
  }
  return prepared;
}

export async function classifyRecordPhotos(recordId: string): Promise<{ classified: number; failed: number }> {
  if (!isAiAvailable()) return { classified: 0, failed: 0 };
  const { rows } = await db.query<PhotoRow>(
    `SELECT id, storage_key, variants, ai_classification_attempts
       FROM ipy_attachment
      WHERE record_id = $1
        AND mime_type LIKE 'image/%'
        AND cull_state = 'keep'
        AND ai_classified_at IS NULL
        AND ai_classification_attempts < $2
      ORDER BY captured_at NULLS LAST, created_at
      LIMIT $3`,
    [recordId, MAX_ATTEMPTS, PHOTOS_PER_CALL],
  );
  if (!rows.length) return { classified: 0, failed: 0 };

  const prepared = await prepare(rows);
  if (!prepared.length) {
    await db.query(
      `UPDATE ipy_attachment
          SET ai_classification_attempts = ai_classification_attempts + 1,
              ai_classification_error = 'Image could not be prepared'
        WHERE id = ANY($1::uuid[])`,
      [rows.map((row) => row.id)],
    );
    return { classified: 0, failed: rows.length };
  }

  try {
    const result = await completeJson<RawClassification>({
      feature: 'property_photo_classification',
      system: SYSTEM,
      recordId,
      images: prepared.map((photo) => photo.image),
      prompt: `The ${prepared.length} photographs are numbered 1 to ${prepared.length} in the order shown.

Return one entry for every photograph in this exact shape:
{
  "photos": [
    { "number": 1, "category": "living_room", "caption": "Bright living room with a false ceiling", "confidence": 0.92 }
  ]
}

Allowed categories only: ${PHOTO_CATEGORIES.join(', ')}.
The caption must be a short, honest description of visible content only.`,
      maxTokens: 1200,
      temperature: 0.1,
    });
    if (!result || !Array.isArray(result.photos)) throw new Error('The vision model returned no photo list');

    const seen = new Set<string>();
    for (const raw of result.photos as RawPhoto[]) {
      const number = Number(raw.number);
      if (!Number.isInteger(number) || number < 1 || number > prepared.length) continue;
      const photo = prepared[number - 1]!;
      if (seen.has(photo.id)) continue;
      seen.add(photo.id);
      const caption = typeof raw.caption === 'string' ? raw.caption.trim().slice(0, 180) : '';
      await db.query(
        `UPDATE ipy_attachment
            SET ai_category = $2, ai_caption = $3, ai_confidence = $4,
                ai_classified_at = now(), ai_classification_attempts = ai_classification_attempts + 1,
                ai_classification_error = NULL
          WHERE id = $1`,
        [photo.id, normaliseCategory(raw.category), caption || null, confidence(raw.confidence)],
      );
    }

    const omitted = prepared.filter((photo) => !seen.has(photo.id));
    if (omitted.length) {
      await db.query(
        `UPDATE ipy_attachment
            SET ai_classification_attempts = ai_classification_attempts + 1,
                ai_classification_error = 'Vision model omitted this photo'
          WHERE id = ANY($1::uuid[])`,
        [omitted.map((photo) => photo.id)],
      );
    }
    return { classified: seen.size, failed: omitted.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.query(
      `UPDATE ipy_attachment
          SET ai_classification_attempts = ai_classification_attempts + 1,
              ai_classification_error = $2
        WHERE id = ANY($1::uuid[])`,
      [prepared.map((photo) => photo.id), message.slice(0, 500)],
    );
    logger.error({ err, recordId }, 'photo classify: vision pass failed');
    return { classified: 0, failed: prepared.length };
  }
}

export async function classifyPendingPropertyPhotos(limit = RECORDS_PER_TICK): Promise<{ classified: number; failed: number }> {
  if (!isAiAvailable()) return { classified: 0, failed: 0 };
  const { rows } = await db.query<{ record_id: string }>(
    `SELECT DISTINCT a.record_id
       FROM ipy_attachment a
       JOIN ipy_record r ON r.id = a.record_id
      WHERE a.record_id IS NOT NULL
        AND a.mime_type LIKE 'image/%'
        AND a.cull_state = 'keep'
        AND a.ai_classified_at IS NULL
        AND a.ai_classification_attempts < $1
        AND r.module_name = 'properties'
        AND r.is_deleted = false
      ORDER BY a.record_id
      LIMIT $2`,
    [MAX_ATTEMPTS, limit],
  );
  let classified = 0;
  let failed = 0;
  for (const row of rows) {
    const result = await classifyRecordPhotos(row.record_id);
    classified += result.classified;
    failed += result.failed;
  }
  if (classified) logger.info({ classified, failed }, 'AI classified property photos');
  return { classified, failed };
}
