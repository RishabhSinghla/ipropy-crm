/**
 * Entry point the scheduler's media queue (core/workflow/scheduler.ts,
 * drainMediaQueue) calls per job. Owns nothing about claiming/retries —
 * just: load the attachment, dispatch by mime type, persist whatever
 * derivatives came back. Throwing here is a real failure the queue should
 * retry; returning normally with no variants recorded is a deliberate
 * no-op (wrong mime type, decode unsupported, etc.), not an error.
 */
import { db } from '../../db/pool.js';
import { formatIndianPrice } from '@ipropy/shared';
import { getDriver } from '../storage/index.js';
import { logger } from '../../utils/logger.js';
import { processImage } from './images.js';
import { processVideo, type TitleCardInfo } from './video.js';
import { captureTimeFromImage, captureTimeFromVideo } from '../capture/captureTime.js';
import { matchAttachment } from '../capture/matching.js';

interface AttachmentRow {
  id: string;
  mime_type: string;
  storage_key: string;
  record_id: string | null;
}

async function isPropertyAttachment(attachmentId: string): Promise<boolean> {
  const owner = await db.queryOne<{ module_name: string | null }>(
    `SELECT r.module_name
       FROM ipy_attachment a
       LEFT JOIN ipy_record r ON r.id = a.record_id
      WHERE a.id = $1`,
    [attachmentId],
  );
  return owner?.module_name === 'properties';
}

/**
 * Read when this was shot and file it against the visit it belongs to.
 *
 * Swallows its own failures on purpose. Matching is an enhancement — the photo
 * is already stored and already attached to whatever the uploader said — so a
 * corrupt EXIF block or a video ffprobe cannot read must not fail the job and
 * cost the file its watermark and its web-sized copies.
 */
async function fileAgainstVisit(attachmentId: string, readTime: () => Promise<Date | null>): Promise<void> {
  try {
    await matchAttachment(attachmentId, await readTime());
  } catch (err) {
    logger.warn({ err, attachmentId }, 'media job: could not file this against a visit, continuing');
  }
}

export async function processAttachment(attachmentId: string): Promise<void> {
  const attachment = await db.queryOne<AttachmentRow>(
    `SELECT id, mime_type, storage_key, record_id FROM ipy_attachment WHERE id = $1`,
    [attachmentId],
  );
  if (!attachment) return; // deleted before the job ran — nothing to do

  const isImage = attachment.mime_type.startsWith('image/');
  const isVideo = attachment.mime_type.startsWith('video/');
  if (!isImage && !isVideo) return; // documents etc. — never had derivatives to make

  const driver = await getDriver();

  let variants: Record<string, string> | null;
  if (isImage) {
    const original = await driver.read(attachment.storage_key);
    if (!original) {
      logger.warn({ attachmentId }, 'media job: original missing from storage, skipping');
      return;
    }
    // Filed against its visit before the derivatives are made, and in its own
    // try/catch: unreadable EXIF is not a reason to skip watermarking a
    // perfectly good photo, and a title card wants the record this may have
    // just supplied.
    await fileAgainstVisit(attachment.id, () => captureTimeFromImage(original));
    variants = await processImage(
      driver,
      attachment.id,
      attachment.storage_key,
      original,
      await isPropertyAttachment(attachment.id) ? 'property' : 'standard',
    );
  } else {
    // Video never gets buffered into memory (a phone clip can be well over a
    // GB) — ffmpeg operates on a real file path via readToTempFile instead.
    const input = await driver.readToTempFile(attachment.storage_key);
    if (!input) {
      logger.warn({ attachmentId }, 'media job: original missing from storage, skipping');
      return;
    }
    try {
      await fileAgainstVisit(attachment.id, () => captureTimeFromVideo(input.path));
      // Re-read: matching may have just given this clip the property whose name
      // belongs on its title card, and the row above was fetched before that.
      const recordId = attachment.record_id ?? (await db.queryOne<{ record_id: string | null }>(
        `SELECT record_id FROM ipy_attachment WHERE id = $1`, [attachment.id],
      ))?.record_id ?? null;
      const titleCard = recordId ? await getTitleCardInfo(recordId) : null;
      variants = await processVideo(driver, attachment.id, attachment.storage_key, input.path, titleCard);
    } finally {
      await input.cleanup();
    }
  }

  if (variants) {
    await db.query(`UPDATE ipy_attachment SET variants = $2::jsonb WHERE id = $1`, [attachment.id, JSON.stringify(variants)]);
  }
}

/**
 * A video's title card shows the property it's actually of — name, price,
 * location — pulled live so it's never stale. Only properties carry that;
 * anything else gets no title card, which processVideo treats as "skip that
 * step", not an error.
 */
async function getTitleCardInfo(recordId: string): Promise<TitleCardInfo | null> {
  const unit = await db.queryOne<{ name: string; project_name: string | null; city: string | null; locality: string | null; total_price: number | null; configuration: string | null }>(
    `SELECT u.name, u.project_name, u.city, u.locality, u.total_price, u.configuration
     FROM ipy_e_properties u
     WHERE u.record_id = $1`,
    [recordId],
  );
  if (unit) {
    return {
      title: unit.project_name ?? unit.name,
      subtitle: [unit.configuration, [unit.locality, unit.city].filter(Boolean).join(', ')].filter(Boolean).join(' · '),
      price: unit.total_price ? formatIndianPrice(unit.total_price) : undefined,
    };
  }

  return null;
}
