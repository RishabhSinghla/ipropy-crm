/**
 * Video derivatives — placeholder for now (see PROJECT_HANDOVER.md §14 build
 * sequence, step 6: transcode + watermark overlay + title card + optional
 * background music). Until that lands, video attachments are simply served
 * as their original upload — correct, if unprocessed, and consistent with
 * the graceful-degradation shape the rest of this pipeline already follows.
 */
import type { StorageDriver } from '../storage/index.js';

export async function processVideo(
  _driver: StorageDriver,
  _attachmentId: string,
  _storageKey: string,
  _original: Buffer,
): Promise<Record<string, string> | null> {
  return null;
}
