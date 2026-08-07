/**
 * Image derivatives for gallery uploads. The original file this reads is
 * never modified or re-uploaded — every derivative is a brand-new object in
 * storage, so "zero quality loss on the master" is an actual guarantee, not
 * a setting. HEIC/HEIF input (iPhone default) decodes through the same path
 * as JPEG/PNG when the platform's libvips build supports it; if decoding
 * fails for any reason this returns null and the caller keeps serving the
 * original untouched — same graceful-degradation shape as ai/client.ts.
 */
import sharp from 'sharp';
import type { StorageDriver } from '../storage/index.js';
import { logger } from '../../utils/logger.js';
import { watermarkFor } from './watermark.js';

const DERIVATIVES = [
  { key: 'thumb', width: 480, watermark: false },
  { key: 'medium', width: 1200, watermark: true },
  { key: 'large', width: 2400, watermark: true },
] as const;

export async function processImage(
  driver: StorageDriver,
  attachmentId: string,
  storageKey: string,
  original: Buffer,
): Promise<Record<string, string> | null> {
  let originalWidth: number;
  try {
    const meta = await sharp(original, { failOn: 'none' }).rotate().metadata();
    originalWidth = meta.width ?? 0;
    if (!originalWidth) throw new Error('no width in decoded metadata');
  } catch (err) {
    logger.warn({ err, attachmentId }, 'media job: image decode failed — serving original only');
    return null;
  }

  const extIndex = storageKey.lastIndexOf('.');
  const base = extIndex === -1 ? storageKey : storageKey.slice(0, extIndex);
  const variants: Record<string, string> = {};

  for (const d of DERIVATIVES) {
    const targetWidth = Math.min(d.width, originalWidth);
    // .rotate() with no args auto-orients from EXIF and strips the tag, so
    // a portrait iPhone shot doesn't come out sideways in the derivative.
    const resized = await sharp(original, { failOn: 'none' })
      .rotate()
      .resize({ width: targetWidth, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });

    let finalBuffer: Buffer = resized.data;
    if (d.watermark) {
      const wm = await watermarkFor(resized.info.width);
      finalBuffer = await sharp(resized.data)
        .composite([{
          input: wm.buffer,
          left: Math.max(0, resized.info.width - wm.width - wm.margin),
          top: Math.max(0, resized.info.height - wm.height - wm.margin),
        }])
        .webp({ quality: 82 })
        .toBuffer();
    }

    const key = `${base}-${d.key}.webp`;
    await driver.save(key, finalBuffer, 'image/webp');
    variants[d.key] = key;
  }

  return variants;
}
