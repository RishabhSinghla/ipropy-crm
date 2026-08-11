/**
 * Looking at the photos in a shoot, so somebody does not have to remember.
 *
 * `grouping.ts` produces a card saying "14 photos, 4:15 pm – 4:41 pm" and asks
 * which property it is. Four thumbnails answer that instantly for this
 * afternoon and not at all for last Tuesday. A model that can read the pictures
 * turns recognition into reading: "3 BHK builder floor — marble flooring,
 * modular kitchen, covered parking" is checkable against a memory in a way that
 * a timestamp is not.
 *
 * Three rules this holds to.
 *
 * **It never writes to the record.** A model can see a modular kitchen. It
 * cannot see that this is B-110 and not B-112 — nothing in the frame says so —
 * and the moment a description is treated as a fact rather than a hint, the
 * reason for asking a person has been thrown away. The output lives on the
 * session and is shown as a caption, nowhere else.
 *
 * **It samples.** A shoot is thirty near-identical frames of four rooms.
 * Sending all of them costs thirty times as much to learn the same thing, and
 * on a free tier is the difference between working and being rate-limited by
 * mid-morning.
 *
 * **It degrades to nothing.** No provider configured is the normal state of
 * this install, and it must cost nothing and mark nothing as failed — a shoot
 * left undescribed for a month must describe itself the hour a key is added.
 */
import sharp from 'sharp';
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { getDriver } from '../storage/index.js';
import { completeJson, isAiAvailable, type VisionImage } from '../../ai/client.js';

/**
 * How many photos from a shoot the model actually sees.
 *
 * Six covers a builder floor — the rooms, the kitchen, a bathroom, the balcony,
 * the outside — without paying for the twenty-five near-duplicates of the
 * living room that a real walkthrough produces. Spread across the shoot's
 * duration rather than taken from the front, because the first six frames of a
 * visit are usually six angles of the same doorway.
 */
export const SAMPLE_SIZE = 6;

/**
 * Longest edge sent to the model.
 *
 * Vision models bill by tile, and an iPhone 17 frame is 8000px of detail nobody
 * asked for. 768 is enough to name a room, read a floor material and see
 * whether a kitchen is modular; it is not enough to read a meter, which is not
 * what this is for.
 */
export const MAX_EDGE = 768;

/** After three refusals this shoot is not going to be described. */
const MAX_ATTEMPTS = 3;

export interface ShootVision {
  /** One line, the length of a card caption. */
  summary: string;
  rooms: string[];
  features: string[];
  /** The attachment the model thought was the best of the ones it saw. */
  coverAttachmentId: string | null;
  describedAt: string;
  /** How many of the shoot's photos were actually looked at. */
  sampled: number;
}

const SYSTEM = `You are looking at photographs from a single Indian real-estate site visit — usually one builder floor or apartment.

Describe only what is visibly in the photographs. Do not infer a price, an address, a unit number, an area in square feet, or a locality: none of those are visible in a photograph, and a confident guess at one is worse than saying nothing.

Write for an Indian property dealer who took these photos and is trying to remember which property they are. Use the vocabulary they use: BHK, builder floor, modular kitchen, false ceiling, vitrified tiles, covered parking, balcony, servant room, puja room, stilt parking.`;

interface Sampled {
  id: string;
  image: VisionImage;
}

/**
 * Evenly spaced picks across a list, always including the first and last.
 *
 * Pure and exported so the spacing is testable without a database — the failure
 * it guards against (taking the first N, which on a real walkthrough is six
 * angles of one doorway) is invisible in a passing integration test.
 */
export function spread<T>(items: T[], count: number): T[] {
  if (items.length <= count) return [...items];
  if (count <= 1) return items.length ? [items[0]!] : [];
  const step = (items.length - 1) / (count - 1);
  const picked: T[] = [];
  for (let i = 0; i < count; i += 1) picked.push(items[Math.round(i * step)]!);
  return picked;
}

/**
 * Read and shrink the photos worth showing the model.
 *
 * Failures per photo are swallowed: one unreadable frame out of thirty should
 * cost that frame, not the whole description. A shoot where every read fails
 * returns nothing and is retried.
 */
async function sampleImages(sessionId: string): Promise<Sampled[]> {
  const { rows } = await db.query<{ id: string; storage_key: string; variants: Record<string, string> | null }>(
    `SELECT id, storage_key, variants
       FROM ipy_attachment
      WHERE shoot_session_id = $1
        AND mime_type LIKE 'image/%'
      ORDER BY captured_at NULLS LAST, created_at`,
    [sessionId],
  );

  const driver = await getDriver();
  const chosen = spread(rows, SAMPLE_SIZE);
  const out: Sampled[] = [];

  for (const row of chosen) {
    try {
      // The web derivative when the media pipeline has made one: already
      // shrunk, already a format sharp opens quickly, and it saves pulling a
      // 12 MB HEIC out of storage to throw 99% of it away.
      const key = row.variants?.web ?? row.variants?.medium ?? row.storage_key;
      const original = await driver.read(key);
      if (!original) continue;

      const data = await sharp(original)
        .rotate() // honour the EXIF orientation, or half a shoot arrives sideways
        .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 75 })
        .toBuffer();

      out.push({ id: row.id, image: { data, mimeType: 'image/jpeg' } });
    } catch (err) {
      logger.debug({ err, attachmentId: row.id }, 'capture: could not prepare a photo for the model');
    }
  }

  return out;
}

interface RawVision {
  summary?: unknown;
  rooms?: unknown;
  features?: unknown;
  cover?: unknown;
}

const asStrings = (value: unknown, limit: number): string[] => (
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((v) => v.trim().slice(0, 40))
      .slice(0, limit)
    : []
);

/**
 * Describe one shoot. Returns null when there is nothing to say — no provider,
 * no photos, or an answer that did not survive parsing.
 *
 * Throws only on a provider failure worth retrying, which is what separates
 * "there is no key" (silence, no attempt spent) from "the request was refused"
 * (an attempt spent, and eventually a give-up).
 */
export async function describeShoot(sessionId: string): Promise<ShootVision | null> {
  if (!isAiAvailable()) return null;

  const sampled = await sampleImages(sessionId);
  if (!sampled.length) return null;

  const result = await completeJson<RawVision>({
    feature: 'shoot_vision',
    system: SYSTEM,
    images: sampled.map((s) => s.image),
    // Numbered so `cover` can be mapped back to a real attachment. Asking for
    // an id instead would invite the model to invent a UUID.
    prompt: `These ${sampled.length} photographs are from one site visit, numbered 1 to ${sampled.length} in the order shown.

Reply with JSON in exactly this shape:

{
  "summary": "one line, at most 90 characters, that would help the photographer recognise this property",
  "rooms": ["the rooms and spaces you can actually see"],
  "features": ["visible finishes and fittings worth noting"],
  "cover": <the number of the single best photo to represent this property>
}

If the photographs are too dark, too blurry or too few to say anything useful, give a short honest summary saying so rather than inventing detail.`,
    maxTokens: 700,
    temperature: 0.1,
  });

  if (!result) throw new Error('the model returned nothing');

  const summary = typeof result.summary === 'string' ? result.summary.trim().slice(0, 160) : '';
  if (!summary) throw new Error('the model returned no summary');

  // 1-based in the prompt because "photo 0" reads as nonsense to a model, and
  // bounds-checked because an out-of-range index is a normal kind of miss.
  const coverNumber = Number(result.cover);
  const coverIndex = Number.isInteger(coverNumber) ? coverNumber - 1 : -1;
  const cover = coverIndex >= 0 && coverIndex < sampled.length ? sampled[coverIndex]! : null;

  return {
    summary,
    rooms: asStrings(result.rooms, 12),
    features: asStrings(result.features, 12),
    coverAttachmentId: cover?.id ?? null,
    describedAt: new Date().toISOString(),
    sampled: sampled.length,
  };
}

interface PendingRow {
  id: string;
  vision_attempts: number;
}

/**
 * Describe the nameless shoots waiting on it.
 *
 * Polled from the scheduler in small batches: each one is several images to a
 * provider on a free tier, and there are a handful a day. Throughput is not the
 * constraint — staying inside a daily quota is.
 *
 * Named shoots are excluded by the query. Once somebody has said which property
 * it is, spending a request to describe it would be paying to be told something
 * we already know.
 */
export async function processPendingShootVisions(limit = 3): Promise<{ done: number; failed: number }> {
  // Not an error and not worth logging every minute: an install with no
  // provider simply shows the thumbnails, exactly as it did before. Crucially
  // no attempt is spent, so a shoot sitting here for a month describes itself
  // the hour a key is added rather than having quietly burned its three tries.
  if (!isAiAvailable()) return { done: 0, failed: 0 };

  const { rows } = await db.query<PendingRow>(
    `SELECT s.id, s.vision_attempts
       FROM ipy_shoot_session s
      WHERE s.vision_status IN ('none', 'pending')
        AND s.record_id IS NULL
        AND s.vision_attempts < $1
        AND EXISTS (
          SELECT 1 FROM ipy_attachment a
           WHERE a.shoot_session_id = s.id AND a.mime_type LIKE 'image/%'
        )
      ORDER BY s.started_at DESC
      LIMIT $2`,
    [MAX_ATTEMPTS, limit],
  );
  if (!rows.length) return { done: 0, failed: 0 };

  let done = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const vision = await describeShoot(row.id);
      if (!vision) continue; // nothing to describe; leave it for another day

      // `record_id IS NULL` in the WHERE, not checked above it: somebody may
      // have named this shoot while the model was thinking, and a caption
      // arriving after that would be writing to a settled row.
      await db.query(
        `UPDATE ipy_shoot_session
            SET vision = $2::jsonb, vision_status = 'done', vision_error = NULL,
                vision_attempts = vision_attempts + 1, updated_at = now()
          WHERE id = $1 AND record_id IS NULL`,
        [row.id, JSON.stringify(vision)],
      );
      done += 1;
    } catch (err) {
      const attempts = row.vision_attempts + 1;
      const message = err instanceof Error ? err.message : String(err);
      await db.query(
        `UPDATE ipy_shoot_session
            SET vision_attempts = $2,
                vision_status = CASE WHEN $2 >= $3 THEN 'failed' ELSE 'pending' END,
                vision_error = $4, updated_at = now()
          WHERE id = $1`,
        [row.id, attempts, MAX_ATTEMPTS, message.slice(0, 500)],
      );
      if (attempts >= MAX_ATTEMPTS) failed += 1;
      logger.warn({ err, sessionId: row.id, attempts }, 'capture: could not describe a shoot');
    }
  }

  if (done || failed) logger.info({ done, failed }, 'capture: described shoots');
  return { done, failed };
}
