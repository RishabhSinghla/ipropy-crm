/**
 * Non-destructive property image factory.
 *
 * The uploaded original is read only. Every output is a new object filed into
 * the property's OneDrive-style folder tree, and the familiar thumb/medium/
 * large variant names stay intact so existing CRM and website consumers do not
 * need to know the storage layout changed.
 */
import sharp from 'sharp';
import type { StorageDriver } from '../storage/index.js';
import { logger } from '../../utils/logger.js';
import {
  derivativeStorageKey, PROPERTY_MEDIA_FOLDERS,
} from '../storage/keys.js';

interface Derivative {
  key: string;
  destination: string;
  suffix: string;
  width?: number;
  height?: number;
  quality?: number;
  lossless?: boolean;
}

const PROPERTY_DERIVATIVES: Derivative[] = [
  // Named after the shape, matching the folders. `contain` below never crops a
  // room to force a ratio; spare area gets a quiet neutral background, because
  // a landscape room cropped to 9:16 keeps under a third of itself.
  { key: 'shape4x5', destination: PROPERTY_MEDIA_FOLDERS.shape4x5, suffix: '4x5', width: 1080, height: 1350, quality: 86 },
  { key: 'shape9x16', destination: PROPERTY_MEDIA_FOLDERS.shape9x16, suffix: '9x16', width: 1080, height: 1920, quality: 86 },
  { key: 'shape1x1', destination: PROPERTY_MEDIA_FOLDERS.shape1x1, suffix: '1x1', width: 1080, height: 1080, quality: 86 },
  { key: 'shape4x3', destination: PROPERTY_MEDIA_FOLDERS.shape4x3, suffix: '4x3', width: 1600, height: 1200, quality: 88 },
  { key: 'shape16x9', destination: PROPERTY_MEDIA_FOLDERS.shape16x9, suffix: '16x9', width: 1920, height: 1080, quality: 84 },
  { key: 'shape2x3', destination: PROPERTY_MEDIA_FOLDERS.shape2x3, suffix: '2x3', width: 1000, height: 1500, quality: 86 },
  { key: 'shape191x1', destination: PROPERTY_MEDIA_FOLDERS.shape191x1, suffix: '1.91x1', width: 1200, height: 627, quality: 84 },

  { key: 'thumb', destination: PROPERTY_MEDIA_FOLDERS.thumbnails, suffix: 'thumb', width: 480, quality: 76 },
];

/** Preserve the old lightweight behaviour for avatars and non-property files. */
const STANDARD_DERIVATIVES: Derivative[] = [
  { key: 'thumb', destination: '', suffix: 'thumb', width: 480, quality: 76 },
  { key: 'medium', destination: '', suffix: 'medium', width: 1200, quality: 82 },
  { key: 'large', destination: '', suffix: 'large', width: 2400, quality: 82 },
];

export async function processImage(
  driver: StorageDriver,
  attachmentId: string,
  storageKey: string,
  original: Buffer,
  profile: 'property' | 'standard' = 'standard',
): Promise<Record<string, string> | null> {
  try {
    const meta = await sharp(original, { failOn: 'none' }).rotate().metadata();
    if (!meta.width || !meta.height) throw new Error('no dimensions in decoded metadata');
  } catch (err) {
    logger.warn({ err, attachmentId }, 'media job: image decode failed — serving original only');
    return null;
  }

  const variants: Record<string, string> = {};
  const derivatives = profile === 'property' ? PROPERTY_DERIVATIVES : STANDARD_DERIVATIVES;
  for (const derivative of derivatives) {
    let transform = sharp(original, { failOn: 'none' }).rotate();
    if (derivative.width && derivative.height) {
      transform = transform.resize(derivative.width, derivative.height, {
        fit: 'contain',
        withoutEnlargement: true,
        background: { r: 247, g: 245, b: 242, alpha: 1 },
      });
    } else if (derivative.width) {
      transform = transform.resize({ width: derivative.width, withoutEnlargement: true });
    }

    const rendered = await transform
      .webp(derivative.lossless
        ? { lossless: true, effort: 5 }
        : { quality: derivative.quality ?? 82, effort: 4 })
      .toBuffer({ resolveWithObject: true });

    const output = rendered.data;

    const key = derivative.destination
      ? derivativeStorageKey(storageKey, derivative.destination, derivative.suffix, '.webp')
      : `${storageKey.slice(0, storageKey.lastIndexOf('.') > -1 ? storageKey.lastIndexOf('.') : storageKey.length)}-${derivative.suffix}.webp`;
    await driver.save(key, output, 'image/webp');
    variants[derivative.key] = key;
  }

  return variants;
}
