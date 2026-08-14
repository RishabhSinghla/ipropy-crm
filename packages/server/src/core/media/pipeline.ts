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
import { needsTranscode, transcodeToJpeg } from './transcode.js';
import { processVideo } from './video.js';
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
    // try/catch: unreadable EXIF is not a reason to skip watermarking and
    // resizing a perfectly good photo.
    //
    // Read from the *original*, deliberately before any transcode: ffmpeg's
    // JPEG output carries no EXIF at all (`-map_metadata 0` included), so
    // reading capture time from the transcode would lose it for every photo.
    //
    // On a full-size HEIC this usually gets nothing anyway. libheif refuses the
    // container before it reaches the EXIF — a 4032x3024 iPhone frame is stored
    // as a tiled grid, and "Number of references in iref box (48) exceeds the
    // security limits of 16" is a refusal, not a decode failure, so no sharp
    // option turns it off. Small HEICs parse fine, which is exactly why this
    // looks like it works when you test it with one.
    //
    // Not worked around here. Capture time is no longer how a photo finds its
    // property — the folder it was dropped into says that — and it now only
    // affects gallery ordering, which the cull/classify pass re-decides anyway.
    // Where it does matter, the folder bridge reads it on the Mac with Apple's
    // own decoder and sends it with the upload, rather than this process
    // guessing at an ISO box layout.
    await fileAgainstVisit(attachment.id, () => captureTimeFromImage(original));
    // Most iPhones shoot HEIC. The original is retained byte-for-byte; ffmpeg
    // supplies only a temporary decoded frame because Sharp's common libvips
    // build cannot decode HEVC pixels even when it recognises the container.
    const pixelSource = needsTranscode(attachment.mime_type)
      ? await transcodeToJpeg(original, attachment.id)
      : original;
    variants = pixelSource
      ? await processImage(
        driver,
        attachment.id,
        attachment.storage_key,
        pixelSource,
        await isPropertyAttachment(attachment.id) ? 'property' : 'standard',
      )
      : null;
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
      variants = await processVideo(driver, attachment.id, attachment.storage_key, input.path);
    } finally {
      await input.cleanup();
    }
  }

  if (variants) {
    await db.query(`UPDATE ipy_attachment SET variants = $2::jsonb WHERE id = $1`, [attachment.id, JSON.stringify(variants)]);
  }
}

