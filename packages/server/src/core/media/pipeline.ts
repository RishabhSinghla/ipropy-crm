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

interface AttachmentRow {
  id: string;
  mime_type: string;
  storage_key: string;
  record_id: string | null;
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
    variants = await processImage(driver, attachment.id, attachment.storage_key, original);
  } else {
    // Video never gets buffered into memory (a phone clip can be well over a
    // GB) — ffmpeg operates on a real file path via readToTempFile instead.
    const input = await driver.readToTempFile(attachment.storage_key);
    if (!input) {
      logger.warn({ attachmentId }, 'media job: original missing from storage, skipping');
      return;
    }
    try {
      const titleCard = attachment.record_id ? await getTitleCardInfo(attachment.record_id) : null;
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
 * location — pulled live so it's never stale. Only projects/properties
 * carry that; anything else (e.g. a document module attachment) gets no
 * title card, which processVideo treats as "skip that step", not an error.
 */
async function getTitleCardInfo(recordId: string): Promise<TitleCardInfo | null> {
  const project = await db.queryOne<{ name: string; city: string | null; locality: string | null; price_min: number | null; price_max: number | null }>(
    `SELECT name, city, locality, price_min, price_max FROM ipy_e_projects WHERE record_id = $1`,
    [recordId],
  );
  if (project) {
    return {
      title: project.name,
      subtitle: [project.locality, project.city].filter(Boolean).join(', '),
      price: project.price_min ? `From ${formatIndianPrice(project.price_min)}` : undefined,
    };
  }

  const unit = await db.queryOne<{ name: string; project_name: string | null; city: string | null; locality: string | null; total_price: number | null; configuration: string | null }>(
    `SELECT u.name, pr.name AS project_name, u.city, u.locality, u.total_price, u.configuration
     FROM ipy_e_properties u LEFT JOIN ipy_e_projects pr ON pr.record_id = u.project_id
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
